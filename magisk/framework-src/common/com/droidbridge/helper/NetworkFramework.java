package com.droidbridge.helper;

import android.net.LinkProperties;
import android.os.IBinder;
import android.os.ServiceManager;
import java.net.InetAddress;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The default network's DNS servers, read from the connectivity service instead of the App. */
final class NetworkFramework {
    private NetworkFramework() {}

    /** `{"dns":[{"server":...}]}` for the active network; an empty list while none is active. */
    static JSONObject dnsServers() throws HelperException, JSONException {
        IBinder binder = ServiceManager.getService("connectivity");
        if (binder == null) throw new HelperException("CAPABILITY_UNAVAILABLE");
        Object properties;
        try {
            Object manager = Class.forName("android.net.IConnectivityManager$Stub")
                .getMethod("asInterface", IBinder.class)
                .invoke(null, binder);
            properties = manager.getClass().getMethod("getActiveLinkProperties").invoke(manager);
        } catch (ReflectiveOperationException | LinkageError error) {
            throw new HelperException("CAPABILITY_UNAVAILABLE");
        }
        JSONArray servers = new JSONArray();
        if (properties instanceof LinkProperties) {
            for (InetAddress server : ((LinkProperties) properties).getDnsServers()) {
                servers.put(new JSONObject().put("server", server.getHostAddress()));
            }
        }
        return new JSONObject().put("dns", servers);
    }
}
