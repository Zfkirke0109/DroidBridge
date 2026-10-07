#!/system/bin/sh
MODDIR=${0%/*}
# A module installed where Android could not install packages leaves its frontend to the first
# boot that can.
(
    until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
    sh "$MODDIR/frontend.sh"
) >/dev/null 2>&1 &
exec "$MODDIR/bin/droidbridge-supervisor" >/dev/null 2>&1
