package com.droidbridge.standalone.runtimehost;

oneway interface IRuntimeEventCallback {
    void onEvent(String projection);
}
