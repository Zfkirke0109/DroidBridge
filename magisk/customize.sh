SKIPUNZIP=0

# APatch and KernelSU both report a Magisk version for compatibility, so each is asked for itself
# first and Magisk answers only for an installer that claims to be neither.
if [ "${APATCH:-false}" = "true" ]; then
    ROOT_PROVIDER=apatch
elif [ "${KSU:-false}" = "true" ]; then
    ROOT_PROVIDER=kernelsu
else
    ROOT_PROVIDER=magisk
fi
printf '%s\n' "$ROOT_PROVIDER" > "$MODPATH/root-provider" || abort "! Cannot record the root provider"

set_perm "$MODPATH/service.sh" 0 0 0755
set_perm "$MODPATH/frontend.sh" 0 0 0755
set_perm "$MODPATH/uninstall.sh" 0 0 0755
set_perm "$MODPATH/root-provider" 0 0 0644
set_perm "$MODPATH/bin/droidbridge-supervisor" 0 0 0755
set_perm "$MODPATH/bin/droidbridged" 0 0 0755
set_perm "$MODPATH/bin/droidbridge-exec-guard" 0 0 0755
set_perm_recursive "$MODPATH/framework" 0 0 0755 0644

# The module and its frontend are one product: the frontend is installed with the module, or at the
# first boot that can install packages when this installer cannot.
if [ -f "$MODPATH/frontend.apk" ]; then
    ui_print "- Installing the DroidBridge Root app"
    if [ "$BOOTMODE" = "true" ] && sh "$MODPATH/frontend.sh"; then
        ui_print "- The app is installed"
    else
        ui_print "- The app will be installed after the next boot"
    fi
fi
