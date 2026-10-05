#!/bin/bash
export PATH=/root/pra-scram/env-old/bin:/usr/local/bin:/usr/bin:/bin
cd /root/pra-scram/build
ninja scram > ../ninja2.log 2>&1; echo rc=$?; tail -3 ../ninja2.log
find . -maxdepth 2 -name scram -type f
ls /root/pra-scram/src/share 2>/dev/null | head
