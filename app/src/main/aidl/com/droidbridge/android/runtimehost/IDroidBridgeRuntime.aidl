package com.droidbridge.android.runtimehost;

import com.droidbridge.android.runtimehost.IRuntimeCallback;
import com.droidbridge.android.runtimehost.IRuntimeEventCallback;

interface IDroidBridgeRuntime {
    void submit(in byte[] envelope, IRuntimeCallback callback);
    void cancelRequest(String requestId);
    void subscribe(IRuntimeEventCallback callback);
    void unsubscribe(IRuntimeEventCallback callback);
    void requestCapabilityRecheck();
    boolean requestShizukuAuthorization();
    String getMcpSettings();
    String setMcpEnabled(boolean enabled);
    String rotateMcpToken();
    String revealMcpToken();
    String getTunnelSettings();
    String configureTunnel(String tunnelId, String apiKey);
    String setTunnelEnabled(boolean enabled);
    String clearTunnel();
    String getMaintenanceState();
    String getDiagnosticsSnapshot();
    String resetRuntimeData();
    String resetRuntimeHostToApk();
    String getUpdateMaintenance();
    String beginProductUpdate(in byte[] manifest, in byte[] signature);
    String installUpdateApk(String updateId);
    String cancelUpdate(String updateId);
    int getStrandedExecutions();
    String clearStrandedExecutions();
    String installEmbeddedModule();
    boolean isModuleRebootPending();
    boolean rebootForModule();
    long getModuleVersionCode();
    String getClaudeRelaySettings();
    String configureClaudeRelay(String relayUrl, String deviceKey);
    String setClaudeRelayEnabled(boolean enabled);
    String clearClaudeRelay();
    String pairClaudeRelay();
    String revokeClaudeRelayClients();
}
