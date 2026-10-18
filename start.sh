#!/bin/zsh
# Starts the Command Center hub. Leave this Terminal window open (or use install-autostart.sh).
cd "${0:A:h}"
[ -x bin/cc-helper ] || ./helper/build.sh
exec /usr/bin/python3 server.py
