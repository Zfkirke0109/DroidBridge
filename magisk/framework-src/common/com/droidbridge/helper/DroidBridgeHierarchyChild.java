package com.droidbridge.helper;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Xml;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.util.concurrent.TimeoutException;
import org.xmlpull.v1.XmlSerializer;

/**
 * The short-lived Root hierarchy reader. It writes the `uiautomator dump` vocabulary, but where
 * `uiautomator dump` gives up on a screen that never becomes idle, this reads such a screen as it
 * is. It connects one UiAutomation for one read and disconnects, so it never holds the single
 * UiAutomation slot, and it never suppresses the accessibility services the user enabled.
 */
public final class DroidBridgeHierarchyChild {
    private static final long IDLE_QUIET_MS = 300;
    private static final long IDLE_LIMIT_MS = 1_500;
    private static final long ROOT_LIMIT_MS = 2_000;
    private static final int MAX_NODES = 10_000;
    private static final int MAX_DEPTH = 256;

    private DroidBridgeHierarchyChild() {}

    public static void main(String[] arguments) {
        try {
            if (arguments.length != 1) throw new IllegalArgumentException("output path required");
            dump(arguments[0]);
        } catch (Throwable error) {
            System.err.println("ERROR: " + error.getClass().getSimpleName());
            System.exit(1);
        }
        System.exit(0);
    }

    private static void dump(String output) throws Exception {
        // The accessibility client binds its handler to the main looper, which app_process lacks.
        Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread("droidbridge-hierarchy");
        thread.start();
        UiAutomation automation = connect(thread.getLooper());
        try {
            try {
                automation.waitForIdle(IDLE_QUIET_MS, IDLE_LIMIT_MS);
            } catch (TimeoutException animating) {
                // A screen that keeps changing is read as it is now.
            }
            AccessibilityNodeInfo root = rootInActiveWindow(automation);
            Display display = defaultDisplay();
            android.graphics.Point size = new android.graphics.Point();
            display.getRealSize(size);
            try (FileOutputStream file = new FileOutputStream(output)) {
                XmlSerializer serializer = Xml.newSerializer();
                serializer.setOutput(file, "UTF-8");
                serializer.startDocument("UTF-8", true);
                serializer.startTag("", "hierarchy");
                serializer.attribute("", "rotation", Integer.toString(display.getRotation()));
                write(serializer, root, 0, 0, new Rect(0, 0, size.x, size.y), new int[] {0});
                serializer.endTag("", "hierarchy");
                serializer.endDocument();
                file.getFD().sync();
            }
        } finally {
            disconnect(automation);
            thread.quitSafely();
        }
    }

    private static UiAutomation connect(Looper looper) throws Exception {
        Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
        Object connection = Class.forName("android.app.UiAutomationConnection")
            .getDeclaredConstructor()
            .newInstance();
        Constructor<UiAutomation> constructor =
            UiAutomation.class.getDeclaredConstructor(Looper.class, connectionType);
        UiAutomation automation = constructor.newInstance(looper, connection);
        UiAutomation.class
            .getMethod("connect", int.class)
            .invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        return automation;
    }

    private static Display defaultDisplay() throws Exception {
        Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object displays = global.getMethod("getInstance").invoke(null);
        return (Display) global.getMethod("getRealDisplay", int.class).invoke(displays, Display.DEFAULT_DISPLAY);
    }

    private static void disconnect(UiAutomation automation) {
        try {
            UiAutomation.class.getMethod("disconnect").invoke(automation);
        } catch (Exception ignored) {
            // The process exits next, which releases the connection with it.
        }
    }

    /** The bridge answers no root for a moment after it connects. */
    private static AccessibilityNodeInfo rootInActiveWindow(UiAutomation automation)
        throws IOException, InterruptedException {
        long deadline = SystemClock.uptimeMillis() + ROOT_LIMIT_MS;
        while (true) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) return root;
            if (SystemClock.uptimeMillis() >= deadline) throw new IOException("no active window");
            Thread.sleep(50);
        }
    }

    /** One node in pre-order, as `uiautomator dump` writes it; children not shown are skipped. */
    private static void write(
        XmlSerializer serializer,
        AccessibilityNodeInfo node,
        int index,
        int depth,
        Rect screen,
        int[] count
    ) throws IOException {
        if (++count[0] > MAX_NODES || depth > MAX_DEPTH) throw new IOException("hierarchy exceeds its bound");
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (!bounds.intersect(screen)) bounds.setEmpty();
        serializer.startTag("", "node");
        serializer.attribute("", "index", Integer.toString(index));
        serializer.attribute("", "text", safe(node.getText()));
        serializer.attribute("", "resource-id", safe(node.getViewIdResourceName()));
        serializer.attribute("", "class", safe(node.getClassName()));
        serializer.attribute("", "package", safe(node.getPackageName()));
        serializer.attribute("", "content-desc", safe(node.getContentDescription()));
        serializer.attribute("", "checkable", Boolean.toString(node.isCheckable()));
        serializer.attribute("", "checked", Boolean.toString(node.isChecked()));
        serializer.attribute("", "clickable", Boolean.toString(node.isClickable()));
        serializer.attribute("", "enabled", Boolean.toString(node.isEnabled()));
        serializer.attribute("", "focusable", Boolean.toString(node.isFocusable()));
        serializer.attribute("", "focused", Boolean.toString(node.isFocused()));
        serializer.attribute("", "scrollable", Boolean.toString(node.isScrollable()));
        serializer.attribute("", "long-clickable", Boolean.toString(node.isLongClickable()));
        serializer.attribute("", "password", Boolean.toString(node.isPassword()));
        serializer.attribute("", "selected", Boolean.toString(node.isSelected()));
        serializer.attribute("", "bounds", bounds.toShortString());
        for (int child = 0; child < node.getChildCount(); child++) {
            AccessibilityNodeInfo next = node.getChild(child);
            if (next == null) continue;
            try {
                if (next.isVisibleToUser()) write(serializer, next, child, depth + 1, screen, count);
            } finally {
                next.recycle();
            }
        }
        serializer.endTag("", "node");
    }

    /** XML 1.0 cannot carry control characters or unpaired surrogates; both become `?`. */
    private static String safe(CharSequence value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean paired = Character.isHighSurrogate(c) && i + 1 < value.length()
                && Character.isLowSurrogate(value.charAt(i + 1));
            if (paired) {
                out.append(c).append(value.charAt(++i));
            } else if (Character.isSurrogate(c) || (c < 0x20 && c != '\t' && c != '\n' && c != '\r')
                || c == 0xFFFE || c == 0xFFFF) {
                out.append('?');
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }
}
