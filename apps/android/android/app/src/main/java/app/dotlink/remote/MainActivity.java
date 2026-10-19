package app.dotlink.remote;

import android.content.Intent;
import android.os.Bundle;

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
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // «Поделиться → DotLink», когда приложение уже открыто
        if (DotLinkPlugin.takeIntent(this, intent) && getBridge() != null) {
            PluginHandle h = getBridge().getPlugin("DotLink");
            if (h != null) ((DotLinkPlugin) h.getInstance()).notifyShared();
        }
    }
}
