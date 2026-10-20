package app.dotlink.remote;

import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DotLinkPlugin.class);
        super.onCreate(savedInstanceState);
        DotLinkPlugin.takeIntent(this, getIntent());
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if ((k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN)
            && DotLinkPlugin.onVolumeKey(k == KeyEvent.KEYCODE_VOLUME_UP, e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0)) {
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // «Поделиться → DotLink», когда приложение уже открыто
        if (DotLinkPlugin.takeIntent(this, intent) && getBridge() != null) {
            PluginHandle h = getBridge().getPlugin("DotLink");
            if (h != null) ((DotLinkPlugin) h.getInstance()).notifyShared();
        }
    }
}
