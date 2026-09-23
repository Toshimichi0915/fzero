#!/bin/bash
# usage: tools/tour.sh <path> <s> <name> [wait]
S=/home/toshimichi/Desktop/projects/fzero/.shots
node tools/shot.mjs "http://localhost:5173/?race" $S/$3.png ${4:-3500} "(()=>{const r=game.race;r.state='race';r.countdown=0;r.autopilot=true;const p=r.player;p.path=$1;p.s=$2;p.x=0;p.v=150;p.air=false;game.chase.snap();game.ui.show(null);return [p.path,Math.round(p.s)]})()" | grep -v 404
