#!/system/bin/sh
# Installs the frontend App this module carries, unless exactly that version is installed already.
MODDIR=${0%/*}
APK="$MODDIR/frontend.apk"
[ -f "$APK" ] || exit 0
PACKAGE=$(cat "$MODDIR/frontend.package") || exit 1
WANTED=$(sed -n 's/^versionCode=//p' "$MODDIR/module.prop")
INSTALLED=$(pm list packages --show-versioncode "$PACKAGE" 2>/dev/null | sed -n "s/^package:$PACKAGE versionCode:\([0-9]*\)\$/\1/p")
[ -n "$WANTED" ] && [ "$INSTALLED" = "$WANTED" ] && exit 0
# The package installer reads the APK from shell storage, which it can always reach.
STAGED=/data/local/tmp/droidbridge-frontend.apk
cp "$APK" "$STAGED" && chmod 0644 "$STAGED" && pm install -r "$STAGED"
STATUS=$?
rm -f "$STAGED"
exit $STATUS
