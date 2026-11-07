#!/bin/sh
# Generates the synthetic clips used by test/ffargs.test.js (default dir /tmp/qc-test).
set -e
D=${1:-/tmp/qc-test}; mkdir -p "$D"; cd "$D"
ffmpeg -v error -y -f lavfi -i testsrc2=s=1920x1080:r=60 -f lavfi -i "sine=f=440:r=48000" -t 20 -c:v libx264 -g 120 -keyint_min 120 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 192k src.mp4
ffmpeg -v error -y -f lavfi -i testsrc2=s=1280x720:r=120 -f lavfi -i "sine=f=300:r=48000" -f lavfi -i "sine=f=600:r=44100" -t 15 -map 0 -map 1 -map 2 -c:v libx265 -x265-params log-level=error:keyint=240 -pix_fmt yuv420p10le -tag:v hvc1 -c:a aac multi.mp4
ffmpeg -v error -y -f lavfi -i testsrc2=s=640x360:r=30 -t 10 -c:v libx264 -g 30 noaudio.mkv
ffmpeg -v error -y -f lavfi -i "sine=f=1000:d=0.5" boom.wav
ffmpeg -v error -y -f lavfi -i "anoisesrc=d=1.2:c=pink" -ac 2 whoosh.mp3
for ext in mp4 mkv; do
  ffmpeg -v error -y -f lavfi -i "color=black:s=640x360:r=60:d=10,drawbox=x=0:y=0:w=640:h=360:color=white:t=fill:enable='between(t,5,5.1)'" \
    -f lavfi -i "sine=f=1000:r=48000:d=10,volume=enable='not(between(t,5,5.1))':volume=0" \
    -c:v libx264 -bf 3 -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 192k sync.$ext
done
echo "test media in $D"
