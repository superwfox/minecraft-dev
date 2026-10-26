import sharp from "sharp";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A native 32-cell drawing, like a Minecraft skin: every mark is a whole pixel.
const side = 32;
const pixels = Array.from({ length: side }, () => Array(side).fill("."));
const palette = {
  ".": [0, 0, 0, 0],
  o: [82, 84, 86, 255],
  s: [149, 151, 153, 255],
  h: [207, 209, 211, 255],
  w: [249, 249, 247, 255],
  k: [31, 32, 34, 255],
};
const ranges = [
  [14,17],[12,19],[11,20],[10,21],[10,21],[3,28],[2,29],[2,29],
  [2,29],[3,28],[1,30],[0,31],[1,30],[1,30],[0,31],[1,30],
  [2,29],[0,31],[1,30],[2,29],[1,30],[1,30],[2,29],[3,28],
  [3,28],[4,27],[5,26],[6,25],[8,23],[11,20],[13,18],[15,16],
];
function set(x, y, color) {
  if (x >= 0 && y >= 0 && x < side && y < side) pixels[y][x] = color;
}
function rect(x1, y1, x2, y2, color) {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) set(x,y,color);
}
function pair(x, y, color) { set(x,y,color); set(31-x,y,color); }
function stamp(x, y, rows, mirror = false) {
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      if (rows[j][i] !== ".") set(mirror ? 31-x-i : x+i, y+j, rows[j][i]);
    }
  }
}
for (let y = 0; y < side; y++) rect(ranges[y][0],y,ranges[y][1],y,"w");
rect(4,3,6,4,"w"); rect(25,3,27,4,"w");
rect(3,4,7,5,"w"); rect(24,4,28,5,"w");
const mask = pixels.map(row => row.map(value => value !== "."));
for (let y=0;y<side;y++) for (let x=0;x<side;x++) {
  if (mask[y][x] && [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => !mask[y+dy]?.[x+dx])) set(x,y,"o");
}
// White-fur ears and the three characteristic forehead curls.
for (const [x,y] of [[4,5],[4,6],[5,6],[4,7],[5,7],[6,7],[5,8],[6,8]]) pair(x,y,"s");
for (const [x,y] of [[15,1],[16,1],[17,1],[18,2],[19,3],[19,4],[18,5],[17,6],[16,6],[15,6],[14,5],[13,4],[13,3],[14,2],[15,2],[16,3],[16,4]]) set(x,y,"s");
const browCurl = [".sss.","swwws","swsws","swwss",".ss.."];
stamp(7,7,browCurl); stamp(7,7,browCurl,true);
const maneCurl = [".ssss.","swwwws","swssws","swswws","swwss.",".ss..."];
stamp(1,12,maneCurl); stamp(1,12,maneCurl,true);
stamp(3,22,maneCurl); stamp(3,22,maneCurl,true);
for (const [x,y] of [[3,10],[4,10],[5,11],[3,18],[4,19],[5,20],[5,27],[6,28],[8,28],[9,29]]) pair(x,y,"h");
// A broad lion face; a pair of plain dark eye blocks, no pupils or highlights.
rect(8,12,23,22,"w");
rect(10,13,11,15,"k"); rect(20,13,21,15,"k");
// The projecting snout is made from two distinct white whisker pads.
for (const [x,y] of [[10,18],[9,19],[8,20],[9,21],[10,22],[11,22],[12,22],[13,22],[14,21]]) pair(x,y,"s");
rect(10,19,14,21,"w"); rect(17,19,21,21,"w");
pair(10,20,"h"); pair(11,21,"h");
rect(13,17,18,18,"o"); rect(14,19,17,19,"o"); rect(15,20,16,21,"o");
rect(14,17,17,17,"h");
// An open animal jaw, with upper fangs, lower teeth and a gray tongue.
const mouth = [
  "..kkkkkkkk..",
  ".kkwwkkwwkk.",
  ".kkwkkkkwkk.",
  "..kkkkkkkk..",
  "..kwksskwk..",
  "...kshhsk...",
  "....oooo....",
];
stamp(10,22,mouth);
pair(11,25,"o"); pair(12,27,"o"); pair(13,29,"h"); pair(14,30,"h");

const rgba = Buffer.from(pixels.flatMap(row => row.flatMap(color => palette[color])));
const path = name => fileURLToPath(new URL(name, import.meta.url));
const names = ["white-lion-upright-32-v8.png","white-lion-upright-32-v8-preview.png","white-lion-rotated45-full-v8.png","white-lion-avatar-32-v8.png","white-lion-avatar-32-v8-preview.png"];
for (const name of names) if (existsSync(path(name))) throw new Error(`Refusing to overwrite ${name}`);
await sharp(rgba,{raw:{width:32,height:32,channels:4}}).png().toFile(path(names[0]));
await sharp(rgba,{raw:{width:32,height:32,channels:4}}).resize(512,512,{kernel:"nearest"}).png().toFile(path(names[1]));

// Nearest-neighbor clockwise rotation, with no interpolation between colors.
const rotatedSide=46, rotated=Buffer.alloc(rotatedSide*rotatedSide*4), c=Math.SQRT1_2;
for(let y=0;y<rotatedSide;y++) for(let x=0;x<rotatedSide;x++) {
  const dx=x-22.5,dy=y-22.5;
  const sx=Math.round(c*dx+c*dy+15.5),sy=Math.round(-c*dx+c*dy+15.5);
  if(sx>=0&&sx<32&&sy>=0&&sy<32) rgba.copy(rotated,(y*rotatedSide+x)*4,(sy*32+sx)*4,(sy*32+sx)*4+4);
}
await sharp(rotated,{raw:{width:46,height:46,channels:4}}).png().toFile(path(names[2]));
await sharp(rotated,{raw:{width:46,height:46,channels:4}}).extract({left:10,top:2,width:32,height:32}).png().toFile(path(names[3]));
await sharp(path(names[3])).resize(512,512,{kernel:"nearest"}).png().toFile(path(names[4]));
for(const name of names) {
  const meta=await sharp(path(name)).metadata();
  console.log(`${name}: ${meta.width}x${meta.height}`);
}
