'use strict';
const ffmpegStatic = require('ffmpeg-static');

// No app empacotado o binário fica fora do .asar (ver "asarUnpack" no package.json).
const FFMPEG = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

module.exports = { FFMPEG };
