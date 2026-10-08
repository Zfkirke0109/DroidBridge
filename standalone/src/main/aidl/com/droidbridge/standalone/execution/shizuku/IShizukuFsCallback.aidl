package com.droidbridge.standalone.execution.shizuku;

import android.os.ParcelFileDescriptor;

interface IShizukuFsCallback {
    void onComplete(
        String executionId,
        in byte[] payload,
        in ParcelFileDescriptor descriptor,
        String errorCode
    );
}
