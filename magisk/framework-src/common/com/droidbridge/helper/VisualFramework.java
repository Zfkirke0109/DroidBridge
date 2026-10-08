package com.droidbridge.helper;

import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.os.IBinder;
import android.os.ServiceManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import org.json.JSONException;
import org.json.JSONObject;

/** The display facts and still-image encoding the Magisk Runtime needs without the App process. */
final class VisualFramework {
    private static final int MAX_SIDE = 16_384;
    private static final long MAX_DECODED_BYTES = 67_108_864L;
    private static final long MAX_ENCODED_BYTES = 8_388_608L;
    private static final int JPEG_QUALITY = 85;
    private static final int DEFAULT_DISPLAY = 0;

    private VisualFramework() {}

    /** Raised from the decoder callback, which cannot throw a checked exception. */
    private static final class OverLimit extends RuntimeException {}

    /**
     * The default display's logical size, rotation in degrees and density from the display
     * service's own DisplayInfo, which has no public accessor outside an App context.
     */
    static JSONObject displaySnapshot() throws HelperException, JSONException {
        IBinder binder = ServiceManager.getService("display");
        if (binder == null) throw new HelperException("CAPABILITY_UNAVAILABLE");
        int width;
        int height;
        int rotation;
        int density;
        try {
            Object manager = Class.forName("android.hardware.display.IDisplayManager$Stub")
                .getMethod("asInterface", IBinder.class)
                .invoke(null, binder);
            Object info = manager.getClass()
                .getMethod("getDisplayInfo", int.class)
                .invoke(manager, DEFAULT_DISPLAY);
            if (info == null) throw new HelperException("CAPABILITY_UNAVAILABLE");
            Class<?> type = info.getClass();
            width = type.getField("logicalWidth").getInt(info);
            height = type.getField("logicalHeight").getInt(info);
            rotation = type.getField("rotation").getInt(info);
            density = type.getField("logicalDensityDpi").getInt(info);
        } catch (ReflectiveOperationException | LinkageError error) {
            throw new HelperException("CAPABILITY_UNAVAILABLE");
        }
        if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE
            || rotation < 0 || rotation > 3 || density <= 0) {
            throw new HelperException("CAPABILITY_UNAVAILABLE");
        }
        return new JSONObject()
            .put("width", width)
            .put("height", height)
            .put("rotation", rotation * 90)
            .put("density_dpi", density);
    }

    /** Decodes [source], keeps [region] when one is named, and writes the JPEG to [output]. */
    static JSONObject transform(String source, String output, JSONObject region)
        throws HelperException, JSONException {
        File input = absolute(source);
        File target = absolute(output);
        Bitmap decoded;
        try {
            decoded = ImageDecoder.decodeBitmap(
                ImageDecoder.createSource(input),
                (decoder, info, ignored) -> {
                    int width = info.getSize().getWidth();
                    int height = info.getSize().getHeight();
                    if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE
                        || (long) width * height * 4 > MAX_DECODED_BYTES) {
                        throw new OverLimit();
                    }
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                });
        } catch (OverLimit error) {
            throw new HelperException("RESOURCE_LIMIT");
        } catch (ImageDecoder.DecodeException error) {
            throw new HelperException("INVALID_ARGUMENT");
        } catch (IOException error) {
            throw new HelperException("IO_ERROR");
        }
        Bitmap kept = decoded;
        try {
            if (region != null) {
                int x = region.getInt("x");
                int y = region.getInt("y");
                int width = region.getInt("width");
                int height = region.getInt("height");
                if (region.length() != 4 || x < 0 || y < 0 || width <= 0 || height <= 0
                    || (long) x + width > decoded.getWidth() || (long) y + height > decoded.getHeight()) {
                    throw new HelperException("INVALID_ARGUMENT");
                }
                kept = Bitmap.createBitmap(decoded, x, y, width, height);
            }
            try (FileOutputStream stream = new FileOutputStream(target)) {
                if (!kept.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)) {
                    throw new HelperException("IO_ERROR");
                }
                stream.getFD().sync();
            } catch (IOException error) {
                throw new HelperException("IO_ERROR");
            }
            long size = target.length();
            if (size < 1 || size > MAX_ENCODED_BYTES) {
                target.delete();
                throw new HelperException("RESOURCE_LIMIT");
            }
            return new JSONObject()
                .put("format", "jpeg")
                .put("mime", "image/jpeg")
                .put("width", kept.getWidth())
                .put("height", kept.getHeight())
                .put("size", size);
        } finally {
            if (kept != decoded) kept.recycle();
            decoded.recycle();
        }
    }

    private static File absolute(String path) throws HelperException {
        if (path.isEmpty() || path.charAt(0) != '/' || path.contains("/../")) {
            throw new HelperException("INVALID_ARGUMENT");
        }
        return new File(path);
    }
}
