package app.dotlink.remote;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * Уведомления телефона на ПК: сообщения, звонки, напоминания видны в дашборде и в уведомлениях
 * Windows. Пересылаются только при открытом соединении и только заголовок и текст; служебные
 * (постоянные, групповые сводки, наши собственные) пропускаются.
 */
public class NotifyService extends NotificationListenerService {
    public interface Sink { void posted(String app, String title, String text); }

    static volatile Sink sink;
    static volatile boolean connected;

    @Override public void onListenerConnected() { connected = true; }
    @Override public void onListenerDisconnected() { connected = false; }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        Sink sk = sink;
        if (sk == null || sbn == null) return;
        Notification n = sbn.getNotification();
        if (n == null || sbn.isOngoing() || getPackageName().equals(sbn.getPackageName())) return;
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle x = n.extras;
        CharSequence title = x.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence text = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (text == null) text = x.getCharSequence(Notification.EXTRA_TEXT);
        if (title == null && text == null) return;
        sk.posted(label(sbn.getPackageName()), title == null ? "" : title.toString(), text == null ? "" : text.toString());
    }

    private String label(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(ai).toString();
        } catch (Exception e) {
            return pkg;
        }
    }
}
