#!/bin/bash
# usage: tools/aerial.sh <path> <s> <name> <back> <up> <side>
S=/home/toshimichi/Desktop/projects/fzero/.shots
node tools/shot.mjs "http://localhost:5173/?race" $S/$3.png 4000 "(()=>{const tr=game.world.track;const p=tr.paths[$1];const f={p:new game.camera.position.constructor(),t:new game.camera.position.constructor(),u:new game.camera.position.constructor(),r:new game.camera.position.constructor()};p.sample($2,f);const tgt=f.p.clone();const pos=f.p.clone().addScaledVector(f.t,-$4).addScaledVector(f.r,$6);pos.y+=$5;game.debugCam=(c)=>{c.position.copy(pos);c.up.set(0,1,0);c.lookAt(tgt);c.fov=65;c.updateProjectionMatrix();};game.ui.show(null);})()" | grep -v 404
