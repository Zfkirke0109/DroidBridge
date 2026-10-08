package com.droidbridge.standalone.runtimehost;

oneway interface IRuntimeCallback {
    void onResponse(in byte[] envelope);
}
