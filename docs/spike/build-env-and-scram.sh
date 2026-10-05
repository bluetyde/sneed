#!/bin/bash
export PATH=/root/miniconda3/bin:/usr/local/bin:/usr/bin:/bin
E=/root/pra-scram/env-old
[ -d $E ] || conda create -y -p $E -c conda-forge --override-channels "gxx_linux-64=11" "cmake=3.27" ninja "boost-cpp=1.78" "libxml2=2.10" python=3.11 pkg-config > /root/pra-scram/conda-old.log 2>&1 || { tail -15 /root/pra-scram/conda-old.log; exit 1; }
export PATH=$E/bin:/usr/local/bin:/usr/bin:/bin
export CC=x86_64-conda-linux-gnu-gcc CXX=x86_64-conda-linux-gnu-g++
cd /root/pra-scram && rm -rf build install && mkdir build && cd build
cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DBOOST_THROW_EXCEPTION_CURRENT_FUNCTION=BOOST_CURRENT_FUNCTION -DBUILD_GUI=OFF -DBUILD_TESTING=ON -DWITH_TCMALLOC=OFF -DWITH_JEMALLOC=OFF -DCMAKE_PREFIX_PATH=$E -DCMAKE_INSTALL_PREFIX=/root/pra-scram/install ../src > ../cmake.log 2>&1 || { tail -25 ../cmake.log; exit 1; }
ninja -j8 > ../ninja.log 2>&1; rc=$?
grep -E "error|Error" ../ninja.log | head -15; tail -5 ../ninja.log; echo rc=$rc