#!/bin/bash
TARGET="$HOME/.cache/querii-bin"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r /home/heisenberg/BuilderValley/querii/dist/querii-linux/* "$TARGET/"
"$TARGET/querii-linux"
