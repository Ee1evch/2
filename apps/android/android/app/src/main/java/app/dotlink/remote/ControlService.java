package app.dotlink.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Управление телефоном с ПК — через службу специальных возможностей (единственный способ без root):
 * касания, долгие нажатия, свайпы и прокрутка жестами, кнопки «Назад/Домой/Недавние», ввод текста
 * в поле в фокусе. Для режима «мышь ПК на телефоне» (как Universal Control) рисует курсор поверх
 * всех окон и превращает кнопки мыши в касания и перетаскивания.
 *
 * Координаты от ПК — доли экрана (0..1), так они не зависят от размера трансляции и поворота.
 */
public class ControlService extends AccessibilityService {
    static volatile ControlService instance;

    private View cursor;
    private WindowManager.LayoutParams cursorLp;
    private float cx, cy;
    private boolean down;
    private float downX, downY;
    private long downAt;

    @Override
    protected void onServiceConnected() {
        instance = this;
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }

    @Override
    public void onDestroy() {
        hideCursor();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private DisplayMetrics screen() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        return m;
    }

    private float px(double frac, boolean x) {
        DisplayMetrics m = screen();
        double v = Math.max(0, Math.min(1, frac)) * (x ? m.widthPixels - 1 : m.heightPixels - 1);
        return (float) v;
    }

    // ───────── жесты ─────────

    private boolean stroke(Path p, long ms) {
        if (Build.VERSION.SDK_INT < 24) return false;
        GestureDescription g = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, Math.min(ms, 59_000))))
            .build();
        return dispatchGesture(g, null, null);
    }

    boolean tap(double x, double y) { return press(px(x, true), px(y, false), 40); }

    boolean longPress(double x, double y, long ms) { return press(px(x, true), px(y, false), Math.max(500, ms)); }

    private boolean press(float x, float y, long ms) {
        Path p = new Path();
        p.moveTo(x, y);
        return stroke(p, ms);
    }

    boolean swipe(double x1, double y1, double x2, double y2, long ms) {
        Path p = new Path();
        p.moveTo(px(x1, true), px(y1, false));
        p.lineTo(px(x2, true), px(y2, false));
        return stroke(p, Math.max(40, ms));
    }

    /** Жест по точкам (рисование, сложные свайпы): [x0, y0, x1, y1, …] в долях экрана. */
    boolean path(double[] pts, long ms) {
        if (pts.length < 4) return false;
        Path p = new Path();
        p.moveTo(px(pts[0], true), px(pts[1], false));
        for (int i = 2; i + 1 < pts.length; i += 2) p.lineTo(px(pts[i], true), px(pts[i + 1], false));
        return stroke(p, Math.max(40, ms));
    }

    /** Прокрутка колесом: свайп от точки в обратную сторону (колесо вниз — содержимое вверх). */
    boolean scroll(double x, double y, double dy, double dx) {
        DisplayMetrics m = screen();
        float sx = px(x, true), sy = px(y, false);
        float ex = clamp(sx + (float) (dx * m.widthPixels), m.widthPixels), ey = clamp(sy + (float) (dy * m.heightPixels), m.heightPixels);
        Path p = new Path();
        p.moveTo(sx, sy);
        p.lineTo(ex, ey);
        return stroke(p, 180);
    }

    private static float clamp(float v, int max) { return Math.max(1, Math.min(max - 2, v)); }

    boolean global(String a) {
        int action;
        switch (a) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick": action = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "power": action = GLOBAL_ACTION_POWER_DIALOG; break;
            case "lock": if (Build.VERSION.SDK_INT >= 28) { action = GLOBAL_ACTION_LOCK_SCREEN; break; } return false;
            case "screenshot": if (Build.VERSION.SDK_INT >= 28) { action = GLOBAL_ACTION_TAKE_SCREENSHOT; break; } return false;
            default: return false;
        }
        return performGlobalAction(action);
    }

    // ───────── текст ─────────

    private AccessibilityNodeInfo focused() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return f != null && f.isEditable() ? f : null;
    }

    /** Напечатать в поле в фокусе (на месте курсора, с заменой выделения). */
    boolean type(String text) {
        AccessibilityNodeInfo f = focused();
        if (f == null) return false;
        CharSequence cur = f.getText();
        String now = cur == null || isHint(f) ? "" : cur.toString();
        int s = Math.max(0, Math.min(now.length(), f.getTextSelectionStart()));
        int e = Math.max(s, Math.min(now.length(), f.getTextSelectionEnd()));
        if (f.getTextSelectionStart() < 0) { s = now.length(); e = s; }
        String next = now.substring(0, s) + text + now.substring(e);
        return setText(f, next, s + text.length());
    }

    private static boolean isHint(AccessibilityNodeInfo f) {
        return Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
    }

    private static boolean setText(AccessibilityNodeInfo f, String text, int caret) {
        Bundle a = new Bundle();
        a.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, a)) return false;
        Bundle sel = new Bundle();
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret);
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret);
        f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        return true;
    }

    /** Клавиши с ПК: Backspace, Delete, Enter, стрелки, выделить всё. */
    boolean key(String k) {
        AccessibilityNodeInfo f = focused();
        switch (k) {
            case "back": return global("back");
            case "home": return global("home");
            case "enter":
                if (f != null && Build.VERSION.SDK_INT >= 30) return f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                return f != null && type("\n");
            default: break;
        }
        if (f == null) return false;
        CharSequence cur = f.getText();
        String now = cur == null || isHint(f) ? "" : cur.toString();
        int s = f.getTextSelectionStart(), e = f.getTextSelectionEnd();
        if (s < 0) { s = now.length(); e = s; }
        s = Math.min(s, now.length());
        e = Math.min(Math.max(e, s), now.length());
        switch (k) {
            case "backspace":
                if (s != e) return setText(f, now.substring(0, s) + now.substring(e), s);
                if (s == 0) return true;
                int from = now.offsetByCodePoints(s, -1);
                return setText(f, now.substring(0, from) + now.substring(s), from);
            case "delete":
                if (s != e) return setText(f, now.substring(0, s) + now.substring(e), s);
                if (s >= now.length()) return true;
                return setText(f, now.substring(0, s) + now.substring(now.offsetByCodePoints(s, 1)), s);
            case "left": return select(f, Math.max(0, s - 1));
            case "right": return select(f, Math.min(now.length(), e + 1));
            case "home-line": return select(f, 0);
            case "end": return select(f, now.length());
            case "select-all": {
                Bundle b = new Bundle();
                b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0);
                b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, now.length());
                return f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, b);
            }
            case "copy": return f.performAction(AccessibilityNodeInfo.ACTION_COPY);
            case "paste": return f.performAction(AccessibilityNodeInfo.ACTION_PASTE);
            case "cut": return f.performAction(AccessibilityNodeInfo.ACTION_CUT);
            default: return false;
        }
    }

    private static boolean select(AccessibilityNodeInfo f, int at) {
        Bundle b = new Bundle();
        b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, at);
        b.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, at);
        return f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, b);
    }

    // ───────── курсор мыши ПК ─────────

    private static class Dot extends View {
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        boolean pressed;
        Dot(android.content.Context c) {
            super(c);
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(4);
            ring.setColor(Color.WHITE);
            fill.setColor(Color.parseColor("#FF4433"));
        }
        @Override protected void onDraw(Canvas c) {
            float r = getWidth() / 2f;
            c.drawCircle(r, r, pressed ? r * 0.62f : r * 0.48f, fill);
            c.drawCircle(r, r, r * 0.62f, ring);
        }
    }

    void showCursor() {
        if (cursor != null) return;
        DisplayMetrics m = screen();
        cx = m.widthPixels / 2f;
        cy = m.heightPixels / 2f;
        int size = (int) (28 * m.density);
        cursorLp = new WindowManager.LayoutParams(size, size, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        cursorLp.gravity = Gravity.TOP | Gravity.START;
        cursor = new Dot(this);
        place();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(cursor, cursorLp);
    }

    void hideCursor() {
        if (cursor == null) return;
        try { ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(cursor); } catch (Exception ignored) { }
        cursor = null;
        down = false;
    }

    private void place() {
        int half = cursorLp.width / 2;
        cursorLp.x = Math.round(cx) - half;
        cursorLp.y = Math.round(cy) - half;
    }

    /** Мышь ПК двигает курсор телефона (dx, dy — пиксели ПК, масштабируем к плотности экрана). */
    void cursorMove(int dx, int dy) {
        if (cursor == null) showCursor();
        DisplayMetrics m = screen();
        float k = Math.max(1f, m.density / 1.5f);
        cx = Math.max(0, Math.min(m.widthPixels - 1, cx + dx * k));
        cy = Math.max(0, Math.min(m.heightPixels - 1, cy + dy * k));
        place();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).updateViewLayout(cursor, cursorLp);
    }

    /** Левая кнопка: короткое нажатие — касание, нажатие с движением — перетаскивание; правая — долгое касание. */
    void cursorButton(int button, boolean isDown) {
        if (cursor == null) showCursor();
        ((Dot) cursor).pressed = isDown;
        cursor.invalidate();
        if (button == 1) { if (isDown) press(cx, cy, 600); return; }
        if (button == 3 && isDown) { global("back"); return; }
        if (button != 0) return;
        if (isDown) {
            down = true;
            downX = cx;
            downY = cy;
            downAt = System.currentTimeMillis();
            return;
        }
        if (!down) return;
        down = false;
        long ms = Math.max(40, Math.min(1500, System.currentTimeMillis() - downAt));
        if (Math.hypot(cx - downX, cy - downY) < 12) {
            press(cx, cy, ms > 450 ? ms : 40);
        } else {
            Path p = new Path();
            p.moveTo(downX, downY);
            p.lineTo(cx, cy);
            stroke(p, ms);
        }
    }

    void cursorScroll(int v, int h) {
        if (cursor == null) showCursor();
        DisplayMetrics m = screen();
        // 120 единиц колеса ≈ 15% высоты экрана
        float dy = v / 120f * 0.15f * m.heightPixels, dx = -h / 120f * 0.15f * m.widthPixels;
        Path p = new Path();
        p.moveTo(cx, cy);
        p.lineTo(clamp(cx + dx, m.widthPixels), clamp(cy + dy, m.heightPixels));
        stroke(p, 150);
    }
}
