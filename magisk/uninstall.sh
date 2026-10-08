#!/system/bin/sh
MODDIR=${0%/*}
for pid in $(pidof droidbridge-supervisor droidbridged 2>/dev/null); do
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
    case "$exe" in
        "$MODDIR/bin/droidbridge-supervisor"|"$MODDIR/bin/droidbridged") kill "$pid" 2>/dev/null ;;
    esac
done

# Removing the module removes the product: its root-only state now, and its frontend App once the
# boot that runs this script can uninstall packages. The module directory is gone by then.
case "${MODDIR##*/}" in
    droidbridge|droidbridge_debug) rm -rf "/data/adb/droidbridge/${MODDIR##*/}" ;;
esac
PACKAGE=$(cat "$MODDIR/frontend.package" 2>/dev/null)
if [ -n "$PACKAGE" ]; then
    (
        until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
        pm uninstall "$PACKAGE"
    ) >/dev/null 2>&1 &
fi
