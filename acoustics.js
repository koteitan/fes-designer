/* acoustics.js — outdoor sound propagation models for Fes Designer.
 * Shared by the main thread (geometry, readouts) and ir-worker.js (impulse responses, level maps).
 *
 * Models used:
 *   - climate: monthly normals per region -> temperature, humidity (vapour pressure kept), pressure from altitude
 *   - ISO 9613-1 atmospheric absorption
 *   - Delany-Bazley ground impedance + Weyl-van der Pol spherical-wave reflection coefficient
 *   - Kurze-Anderson barrier diffraction (+ transmission loss of the wall)
 *   - line-array near field (cylindrical spreading up to L^2 f / 2c)
 *   - refraction by wind / temperature gradients (shadow zone, downward bending)
 *   - turbulence: decorrelation of direct and ground-reflected sound
 *   - Brown-Duda spherical head model (ITD + head shadow)
 *   - first-order image sources (buildings, stadium stands, mountains)
 *   - statistical reverberant tails (venue, surroundings)
 */
(function (root) {
'use strict';
const A = {};
const TAU = 2 * Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const db2a = db => Math.pow(10, db / 20);
A.clamp = clamp;
A.LISTENER_Z = 1.6;
A.BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
A.AWEIGHT = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1];
A.CROWD = { sigma: 30, plane: 1.2 };
A.HEAD_RADIUS = 0.0875;

// ------------------------------------------------------------------ tables
// monthly mean temperature (deg C) and relative humidity (%), approximate climate normals
// amp: half of the typical daily temperature range, windMul: local windiness
const city = (name, group, env, alt, amp, windMul, T, RH) => ({ name, group, env, alt, amp, windMul, T, RH });
A.REGIONS = {
  // 日本
  tokyo: city('東京 (都市)', '日本', 'urban', 5, 3.5, 0.8,
    [5.4, 6.1, 9.4, 14.3, 18.8, 21.9, 25.7, 26.9, 23.3, 18.0, 12.5, 7.7], [52, 53, 57, 62, 66, 75, 77, 73, 75, 71, 64, 56]),
  osaka: city('大阪 (都市)', '日本', 'urban', 5, 3.8, 0.8,
    [6.2, 6.7, 9.9, 15.5, 20.3, 23.6, 27.7, 29.0, 25.2, 19.5, 13.8, 8.7], [61, 61, 60, 60, 63, 70, 72, 68, 69, 66, 65, 63]),
  fukuoka: city('福岡 (都市)', '日本', 'urban', 5, 3.8, 0.9,
    [6.9, 7.8, 10.8, 15.4, 19.9, 23.3, 27.4, 28.4, 24.7, 19.6, 14.2, 9.1], [63, 64, 66, 67, 70, 77, 77, 74, 74, 68, 67, 65]),
  sapporo: city('札幌 (公園・郊外)', '日本', 'suburban', 20, 4, 0.9,
    [-3.6, -3.1, 0.6, 7.1, 12.4, 16.7, 20.5, 22.3, 18.6, 12.1, 5.2, -0.9], [70, 69, 66, 62, 68, 75, 79, 77, 74, 70, 69, 70]),
  naha: city('那覇 (海辺)', '日本', 'seaside', 5, 2.5, 1.5,
    [17.3, 17.5, 19.1, 21.5, 24.2, 27.2, 29.1, 29.0, 27.9, 25.5, 22.5, 19.0], [69, 71, 74, 77, 80, 84, 79, 79, 76, 71, 70, 67]),
  // アジア
  seoul: city('ソウル', 'アジア', 'urban', 40, 4.5, 0.9,
    [-2.4, 0.4, 5.7, 12.5, 17.8, 22.2, 24.9, 25.7, 21.2, 14.8, 7.2, 0.4], [57, 56, 57, 56, 62, 68, 78, 75, 69, 64, 61, 58]),
  beijing: city('北京', 'アジア', 'urban', 50, 5.5, 0.9,
    [-3.1, 0.3, 6.7, 14.8, 20.8, 24.9, 26.7, 25.5, 20.8, 13.7, 5.0, -0.9], [44, 44, 46, 46, 53, 61, 75, 77, 68, 61, 57, 49]),
  shanghai: city('上海', 'アジア', 'urban', 5, 3.5, 0.9,
    [4.8, 6.6, 10.3, 15.8, 21.0, 24.8, 29.0, 28.6, 24.9, 19.9, 13.9, 7.5], [74, 74, 73, 73, 74, 80, 78, 78, 77, 73, 74, 72]),
  hongkong: city('香港', 'アジア', 'urban', 30, 2.5, 1.0,
    [16.3, 16.8, 19.1, 22.6, 25.9, 27.9, 28.8, 28.6, 27.7, 25.5, 21.8, 17.9], [74, 80, 82, 83, 83, 82, 80, 80, 77, 72, 71, 69]),
  taipei: city('台北', 'アジア', 'urban', 10, 3, 0.8,
    [16.1, 16.5, 18.5, 21.9, 25.2, 27.7, 29.6, 29.2, 27.4, 24.5, 21.5, 17.9], [78, 80, 79, 78, 77, 78, 74, 75, 76, 75, 76, 76]),
  manila: city('マニラ', 'アジア', 'urban', 10, 3.5, 0.9,
    [26.3, 26.8, 28.1, 29.6, 29.9, 29.0, 28.0, 27.7, 27.7, 27.6, 27.3, 26.5], [73, 70, 67, 66, 71, 77, 81, 83, 82, 80, 77, 75]),
  bangkok: city('バンコク', 'アジア', 'urban', 5, 4, 0.7,
    [27.0, 28.3, 29.5, 30.5, 29.9, 29.5, 29.0, 28.8, 28.3, 28.1, 27.8, 26.3], [69, 72, 72, 72, 75, 75, 76, 77, 80, 79, 72, 67]),
  singapore: city('シンガポール', 'アジア', 'urban', 15, 3, 0.7,
    [26.5, 27.1, 27.5, 28.0, 28.3, 28.3, 27.9, 27.9, 27.6, 27.6, 26.9, 26.4], [84, 81, 82, 84, 84, 82, 82, 82, 83, 84, 87, 87]),
  jakarta: city('ジャカルタ', 'アジア', 'urban', 10, 3, 0.7,
    [26.7, 26.8, 27.3, 27.9, 28.1, 27.8, 27.6, 27.8, 28.1, 28.2, 27.9, 27.3], [85, 85, 83, 82, 80, 79, 76, 74, 74, 76, 80, 83]),
  mumbai: city('ムンバイ', 'アジア', 'urban', 15, 3.5, 1.0,
    [24.4, 25.3, 27.2, 28.8, 30.3, 29.6, 28.2, 27.8, 28.0, 28.9, 28.1, 26.0], [69, 69, 71, 73, 73, 80, 85, 85, 83, 77, 70, 69]),
  // オセアニア
  sydney: city('シドニー', 'オセアニア', 'urban', 40, 3.5, 1.1,
    [23.5, 23.4, 22.1, 19.5, 16.6, 14.2, 13.4, 14.5, 17.0, 19.0, 20.4, 22.1], [65, 68, 67, 65, 66, 65, 60, 56, 56, 58, 62, 63]),
  melbourne: city('メルボルン', 'オセアニア', 'urban', 30, 5, 1.2,
    [21.2, 21.4, 19.5, 16.6, 13.8, 11.4, 10.7, 11.8, 13.6, 15.6, 17.8, 19.6], [58, 59, 61, 64, 71, 75, 74, 68, 64, 61, 61, 58]),
  auckland: city('オークランド', 'オセアニア', 'urban', 30, 3.5, 1.3,
    [19.9, 20.3, 19.0, 16.9, 14.6, 12.6, 11.6, 12.0, 13.4, 14.8, 16.5, 18.4], [71, 72, 73, 76, 80, 82, 82, 79, 76, 73, 71, 71]),
  // 北米
  losangeles: city('ロサンゼルス', '北米', 'urban', 90, 5, 0.9,
    [14.3, 14.8, 15.7, 17.0, 18.3, 20.2, 22.4, 23.1, 22.6, 20.4, 17.1, 14.3], [63, 67, 69, 70, 73, 75, 76, 76, 74, 71, 65, 62]),
  sanfrancisco: city('サンフランシスコ', '北米', 'urban', 20, 4, 1.4,
    [10.9, 12.3, 13.2, 14.1, 15.2, 16.6, 17.2, 17.8, 18.4, 17.2, 13.8, 11.0], [76, 75, 73, 71, 73, 74, 76, 77, 74, 72, 73, 76]),
  lasvegas: city('ラスベガス (乾燥 標高610m)', '北米', 'urban', 610, 7, 1.1,
    [8.6, 11.2, 15.2, 19.4, 24.6, 30.2, 33.4, 32.4, 28.0, 20.8, 13.4, 8.1], [41, 36, 29, 22, 18, 14, 17, 20, 21, 25, 34, 40]),
  denver: city('デンバー (標高1600m)', '北米', 'urban', 1609, 8, 1.1,
    [-0.6, 0.4, 4.6, 8.6, 13.9, 19.6, 23.4, 22.3, 17.7, 10.8, 4.3, -0.6], [55, 54, 50, 46, 49, 44, 43, 45, 44, 45, 54, 57]),
  chicago: city('シカゴ', '北米', 'urban', 180, 5, 1.3,
    [-4.6, -2.6, 3.2, 9.4, 15.4, 21.0, 24.0, 23.1, 19.1, 12.4, 5.4, -1.3], [72, 71, 68, 64, 64, 66, 68, 70, 70, 68, 72, 75]),
  toronto: city('トロント', '北米', 'urban', 80, 5, 1.1,
    [-5.5, -4.5, 0.0, 6.5, 13.0, 18.5, 21.5, 20.6, 16.4, 9.9, 3.9, -2.2], [74, 72, 68, 64, 66, 68, 69, 72, 74, 74, 77, 78]),
  newyork: city('ニューヨーク', '北米', 'urban', 10, 4.5, 1.1,
    [0.5, 1.7, 5.7, 11.9, 17.4, 22.4, 25.3, 24.7, 20.8, 14.6, 8.9, 3.4], [61, 59, 57, 55, 62, 65, 65, 67, 68, 65, 64, 63]),
  // 中南米
  mexicocity: city('メキシコシティ (標高2240m)', '中南米', 'urban', 2240, 8, 0.8,
    [14.4, 15.8, 18.0, 19.3, 19.6, 18.8, 17.6, 17.8, 17.4, 16.4, 15.3, 14.4], [52, 46, 41, 44, 52, 64, 70, 71, 73, 67, 60, 56]),
  saopaulo: city('サンパウロ (標高760m)', '中南米', 'urban', 760, 4.5, 0.9,
    [23.0, 23.4, 22.6, 20.9, 18.7, 17.6, 17.0, 18.3, 19.0, 20.5, 21.4, 22.4], [79, 79, 80, 79, 78, 77, 74, 71, 74, 77, 77, 79]),
  rio: city('リオデジャネイロ (海辺)', '中南米', 'seaside', 10, 3.5, 1.2,
    [26.5, 27.0, 26.3, 24.7, 23.2, 22.0, 21.5, 22.0, 22.3, 23.3, 24.5, 25.8], [79, 79, 80, 80, 80, 79, 77, 77, 79, 80, 79, 80]),
  buenosaires: city('ブエノスアイレス', '中南米', 'urban', 25, 5, 1.1,
    [24.5, 23.5, 21.5, 17.9, 14.6, 11.6, 10.9, 12.5, 14.6, 17.8, 20.6, 23.3], [64, 69, 73, 76, 77, 79, 77, 73, 70, 71, 67, 63]),
  santiago: city('サンティアゴ', '中南米', 'urban', 570, 9, 0.8,
    [21.0, 20.4, 18.2, 14.7, 11.4, 8.8, 8.5, 9.6, 11.6, 14.4, 17.2, 19.8], [52, 54, 57, 64, 73, 79, 78, 74, 70, 63, 56, 52]),
  // ヨーロッパ
  london: city('ロンドン', 'ヨーロッパ', 'urban', 20, 4, 1.1,
    [5.2, 5.3, 7.6, 9.9, 13.3, 16.5, 18.7, 18.5, 15.7, 12.0, 8.0, 5.5], [81, 77, 72, 67, 67, 66, 66, 69, 73, 78, 81, 82]),
  dublin: city('ダブリン', 'ヨーロッパ', 'urban', 20, 3.5, 1.3,
    [5.3, 5.4, 6.7, 8.4, 10.9, 13.6, 15.3, 15.0, 13.3, 10.8, 7.6, 5.6], [86, 84, 80, 77, 76, 77, 79, 81, 83, 85, 87, 87]),
  paris: city('パリ', 'ヨーロッパ', 'urban', 40, 4.5, 1.0,
    [5.0, 5.6, 8.8, 11.5, 15.2, 18.3, 20.5, 20.3, 16.9, 13.0, 8.3, 5.5], [83, 78, 73, 69, 70, 69, 68, 71, 76, 82, 84, 85]),
  amsterdam: city('アムステルダム', 'ヨーロッパ', 'urban', 0, 3.5, 1.4,
    [3.6, 4.0, 6.6, 9.6, 13.3, 16.0, 18.1, 17.9, 15.0, 11.4, 7.4, 4.4], [87, 84, 80, 74, 73, 76, 77, 78, 82, 85, 88, 89]),
  berlin: city('ベルリン', 'ヨーロッパ', 'urban', 35, 4.5, 1.0,
    [0.6, 1.4, 4.8, 9.6, 14.2, 17.4, 19.6, 19.2, 14.9, 10.0, 5.1, 1.7], [85, 82, 76, 67, 66, 67, 68, 70, 77, 82, 86, 87]),
  stockholm: city('ストックホルム', 'ヨーロッパ', 'urban', 20, 4, 1.0,
    [-1.6, -1.7, 0.7, 5.5, 11.1, 15.6, 18.4, 17.4, 12.9, 7.5, 3.2, 0.0], [85, 83, 77, 70, 64, 66, 69, 74, 79, 83, 87, 87]),
  milan: city('ミラノ', 'ヨーロッパ', 'urban', 120, 5, 0.7,
    [2.5, 4.7, 9.0, 12.8, 17.5, 21.5, 24.0, 23.4, 19.0, 13.4, 7.6, 3.4], [85, 78, 71, 73, 73, 71, 70, 72, 74, 81, 85, 86]),
  madrid: city('マドリード (標高650m)', 'ヨーロッパ', 'urban', 650, 7, 0.9,
    [6.3, 7.9, 11.2, 12.9, 16.7, 22.2, 25.6, 25.1, 20.9, 15.1, 9.9, 6.9], [71, 64, 56, 56, 51, 42, 37, 39, 49, 62, 70, 74]),
  barcelona: city('バルセロナ', 'ヨーロッパ', 'urban', 10, 3.5, 1.0,
    [11.2, 11.8, 13.6, 15.5, 18.7, 22.4, 25.3, 25.8, 23.1, 19.7, 15.1, 12.2], [69, 67, 68, 69, 70, 69, 68, 70, 72, 73, 70, 69]),
  // 中東・アフリカ
  dubai: city('ドバイ', '中東・アフリカ', 'urban', 5, 5, 1.1,
    [19.7, 20.9, 23.6, 27.6, 31.8, 33.8, 35.7, 36.0, 33.4, 29.9, 25.5, 21.4], [65, 65, 63, 55, 53, 58, 56, 57, 60, 60, 61, 64]),
  johannesburg: city('ヨハネスブルグ (標高1750m)', '中東・アフリカ', 'urban', 1750, 7, 1.0,
    [20.0, 19.6, 18.6, 15.9, 13.0, 10.2, 10.4, 13.0, 16.4, 18.0, 18.6, 19.6], [70, 72, 72, 68, 60, 57, 53, 46, 46, 56, 65, 68]),
  // 郊外・自然のフェス会場
  naeba: city('新潟 苗場 (山の中 標高900m)', '自然の中のフェス会場', 'mountain', 900, 5, 0.7,
    [-4.0, -3.5, 0.0, 6.0, 12.0, 16.0, 20.0, 21.0, 17.0, 10.5, 4.5, -1.0], [85, 83, 78, 72, 72, 80, 83, 82, 83, 80, 80, 84]),
  desert: city('カリフォルニア 砂漠 (乾燥)', '自然の中のフェス会場', 'desert', 0, 6, 1.2,
    [14, 16, 19, 23, 27, 32, 35, 34, 31, 25, 18, 13], [40, 38, 32, 25, 22, 20, 25, 28, 28, 30, 36, 40]),
  somerset: city('イギリス 田園 (牧草地)', '自然の中のフェス会場', 'farmland', 30, 4, 1.1,
    [5, 5, 7, 9, 12, 15, 17, 17, 14, 11, 8, 5], [87, 84, 80, 76, 75, 75, 76, 78, 81, 85, 87, 88]),
};

// day / night: effective sound-speed gradient caused by temperature (1/s)
A.WEATHER = {
  clear:  { name: '快晴', ampMul: 1.3, wind: 2, day: -0.14, night: 0.16 },
  sunny:  { name: '晴れ', ampMul: 1.0, wind: 3, day: -0.09, night: 0.10 },
  cloudy: { name: 'くもり', ampMul: 0.5, wind: 3.5, day: -0.02, night: 0.02 },
  rain:   { name: '雨', ampMul: 0.3, wind: 4.5, day: 0, night: 0, dT: -2, rhMin: 95, rain: 1, wet: 1 },
  fog:    { name: '霧', ampMul: 0.3, wind: 0.7, day: 0.03, night: 0.06, dT: -1, rhMin: 100 },
  snow:   { name: '雪', ampMul: 0.3, wind: 3, day: 0, night: 0.03, Tmax: -1, rhMin: 90, snow: 1 },
  storm:  { name: '強風', ampMul: 0.7, wind: 11, day: 0, night: 0 },
};

A.TIMES = {
  morning: { name: '朝 (7時)', off: -0.8, grad: w => 0.4 * w.night },
  noon:    { name: '昼 (14時)', off: 1.0, grad: w => w.day },
  evening: { name: '夕方 (18時)', off: 0.3, grad: w => 0.3 * w.day },
  night:   { name: '夜 (21時)', off: -0.6, grad: w => w.night },
};

// direction the wind blows TOWARD (x: audience right, y: away from stage)
A.WIND_DIRS = {
  toAudience: { name: 'ステージ → 客席 (追い風)', v: [0, 1] },
  toStage:    { name: '客席 → ステージ (向かい風)', v: [0, -1] },
  toRight:    { name: '左 → 右 (横風)', v: [1, 0] },
  toLeft:     { name: '右 → 左 (横風)', v: [-1, 0] },
};

// flow resistivity sigma in kPa s m^-2
A.GROUNDS = {
  grass:    { name: '芝生', sigma: 200, step: 'grass', color: '#2f5a2a' },
  soil:     { name: '土 (踏み固め)', sigma: 2000, step: 'soil', color: '#5a4630' },
  sand:     { name: '砂', sigma: 500, step: 'sand', color: '#8a7748' },
  gravel:   { name: '砂利', sigma: 800, step: 'gravel', color: '#5c5c58' },
  asphalt:  { name: 'アスファルト', sigma: 20000, step: 'asphalt', color: '#3a3a3e' },
  concrete: { name: 'コンクリート', sigma: 200000, step: 'asphalt', color: '#55565a' },
  snow:     { name: '雪', sigma: 25, step: 'snow', color: '#8f9aa6' },
};

// kappa: strength of the diffuse field returned by the surroundings, RT in seconds
// misc: scattering by trees, buildings, cars, stalls outside the audience area,
//   as a multiple of the ISO 9613-2 foliage table, over at most maxD metres
A.ENVS = {
  urban:    { name: '都市 (ビル街)', kappa: 0.12, RT: 1.4, onset: 0.06, misc: 0.5, maxD: 300 },
  suburban: { name: '郊外 (公園・木立)', kappa: 0.05, RT: 0.9, onset: 0.04, misc: 0.6, maxD: 250 },
  mountain: { name: '山 (尾根・森)', kappa: 0.06, RT: 2.5, onset: 0.15, misc: 1.0, maxD: 200 },
  seaside:  { name: '海辺 (開けた浜)', kappa: 0.015, RT: 0.5, onset: 0.03, misc: 0.15, maxD: 200 },
  desert:   { name: '砂漠 (何もない)', kappa: 0.008, RT: 0.4, onset: 0.03, misc: 0.05, maxD: 200 },
  farmland: { name: '田園 (生け垣・丘)', kappa: 0.025, RT: 0.7, onset: 0.04, misc: 0.35, maxD: 250 },
};
const RT_SHAPE = [1.15, 1.1, 1.05, 1, 0.95, 0.85, 0.7, 0.5];
// ISO 9613-2 Table A.1: attenuation through dense foliage, dB/m (63 Hz .. 8 kHz)
const FOLIAGE = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.12];
function foliage(f) {
  const x = clamp(Math.log2(f / 63), 0, 7), i = Math.min(6, Math.floor(x)), u = x - i;
  return FOLIAGE[i] * (1 - u) + FOLIAGE[i + 1] * u;
}
// scattering loss (dB) for a listener d metres beyond the audience area
A.miscDb = function (scene, f, d) {
  const e = scene.envP;
  return Math.min(25, foliage(f) * e.misc * Math.min(d, e.maxD));
};

A.VENUES = {
  park: { name: '公園の野外ステージ (2,000人)', kind: 'field', W: 70, D: 60, back: 20, fenceH: 2.0, fenceTL: 5,
    stageW: 14, stageD: 10, stageH: 9, foh: 22, tail: { V: 70 * 80 * 8, RT: 0.5, scale: 0.12, onset: 0.015, hv: 8 } },
  fes: { name: '野外フェス メインステージ (30,000人)', kind: 'field', W: 200, D: 170, back: 35, fenceH: 3, fenceTL: 8,
    stageW: 32, stageD: 18, stageH: 18, foh: 45, tail: { V: 200 * 205 * 10, RT: 0.7, scale: 0.25, onset: 0.02, hv: 12 } },
  stadium: { name: 'スタジアム (50,000人)', kind: 'stadium', rx: 135, ry: 120, frx: 80, fry: 70, wallH: 40, wallTL: 22,
    stageW: 30, stageD: 16, stageH: 18, foh: 50, tail: { V: Math.PI * 135 * 120 * 28, RT: 2.4, scale: 1, onset: 0.04, hv: 30 } },
  mega: { name: '巨大フェス (100,000人)', kind: 'field', W: 330, D: 320, back: 45, fenceH: 3, fenceTL: 8,
    stageW: 44, stageD: 22, stageH: 24, foh: 65, tail: { V: 330 * 365 * 12, RT: 0.8, scale: 0.25, onset: 0.025, hv: 14 } },
};

A.SYSTEMS = {
  point:  { name: '小型PA (ポイントソース + サブ)', top: 'point', L: 0, h: 5, subs: 'sub', towers: [] },
  lineM:  { name: '中型ラインアレイ', top: 'line', L: 3.5, h: 9, subs: 'sub', towers: [] },
  lineL:  { name: '大型ラインアレイ + ディレイタワー', top: 'line', L: 7, h: 14, subs: 'subc', towers: [0.5] },
  lineXL: { name: '超大型ラインアレイ + ディレイタワー2列', top: 'line', L: 9, h: 17, subs: 'subc', towers: [0.38, 0.7] },
};

// ------------------------------------------------------------------ climate
A.es = T => 6.112 * Math.exp(17.62 * T / (243.12 + T)); // saturation vapour pressure, hPa

A.climate = function (st) {
  const R = A.REGIONS[st.region], W = A.WEATHER[st.weather], tod = A.TIMES[st.tod];
  const Tm = R.T[st.month];
  const e = R.RH[st.month] / 100 * A.es(Tm); // vapour pressure is kept through the day
  let T = Tm + tod.off * R.amp * W.ampMul + (W.dT || 0);
  if (W.Tmax != null) T = Math.min(T, W.Tmax);
  let RH = 100 * e / A.es(T);
  if (W.rhMin != null) RH = Math.max(RH, W.rhMin);
  RH = clamp(RH, 3, 100);
  const p = 101.325 * Math.pow(1 - 2.25577e-5 * R.alt, 5.25588);
  const c = 331.3 * Math.sqrt(1 + T / 273.15) + 0.6 * RH / 100 * A.es(T) / 23.4;
  return {
    T, RH, p, c, alt: R.alt,
    wind: W.wind * R.windMul, windDir: A.WIND_DIRS[st.windDir].v,
    gradT: tod.grad(W), rain: !!W.rain, snow: !!W.snow, wet: !!W.wet,
  };
};

// ISO 9613-1 pure-tone atmospheric absorption, dB/m
A.airAbsorption = function (f, T, RH, p) {
  const Tk = T + 273.15, T0 = 293.15, T01 = 273.16, pr = 101.325;
  const C = -6.8346 * Math.pow(T01 / Tk, 1.261) + 4.6151;
  const pa = p / pr;
  const h = RH * Math.pow(10, C) / pa; // molar concentration of water vapour, %
  const frO = pa * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
  const frN = pa * Math.pow(Tk / T0, -0.5) * (9 + 280 * h * Math.exp(-4.170 * (Math.pow(Tk / T0, -1 / 3) - 1)));
  const f2 = f * f;
  return 8.686 * f2 * (1.84e-11 / pa * Math.sqrt(Tk / T0) + Math.pow(Tk / T0, -2.5) * (
    0.01275 * Math.exp(-2239.1 / Tk) / (frO + f2 / frO) +
    0.1068 * Math.exp(-3352.0 / Tk) / (frN + f2 / frN)));
};

// ------------------------------------------------------------------ ground
// Delany-Bazley normalised impedance (e^{-iwt} convention), sigma in kPa s m^-2
A.groundZ = function (f, sigma) {
  const X = Math.max(f, 1) / sigma;
  return [1 + 9.08 * Math.pow(X, -0.75), 11.9 * Math.pow(X, -0.73)];
};

function cdiv(ar, ai, br, bi) {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}

// Faddeeva function w(z) = exp(-z^2) erfc(-iz), Humlicek (1982) W4 rational approximation
function faddeeva(x, y) {
  if (y < 0) { // w(z) = 2 exp(-z^2) - w(-z)
    const r = faddeeva(-x, -y);
    const ex = Math.exp(Math.min(700, y * y - x * x)), ph = -2 * x * y;
    return [2 * ex * Math.cos(ph) - r[0], 2 * ex * Math.sin(ph) - r[1]];
  }
  const tr = y, ti = -x; // t = y - i x
  const s = Math.abs(x) + y;
  if (s >= 15) {
    return cdiv(0.5641896 * tr, 0.5641896 * ti, tr * tr - ti * ti + 0.5, 2 * tr * ti);
  }
  if (s >= 5.5) {
    const ur = tr * tr - ti * ti, ui = 2 * tr * ti;
    const ar = 1.410474 + 0.5641896 * ur, ai = 0.5641896 * ui;
    const nr = tr * ar - ti * ai, ni = tr * ai + ti * ar;
    const br = 3 + ur, bi = ui;
    return cdiv(nr, ni, 0.75 + ur * br - ui * bi, ur * bi + ui * br);
  }
  if (y >= 0.195 * Math.abs(x) - 0.176) {
    const num = [0.5642236, 3.778987, 11.96482, 20.20933, 16.4955];
    const den = [1, 6.699398, 21.69274, 39.27121, 38.82363, 16.4955];
    let pr = num[0], pi = 0;
    for (let i = 1; i < num.length; i++) { const r = pr * tr - pi * ti + num[i]; pi = pr * ti + pi * tr; pr = r; }
    let qr = den[0], qi = 0;
    for (let i = 1; i < den.length; i++) { const r = qr * tr - qi * ti + den[i]; qi = qr * ti + qi * tr; qr = r; }
    return cdiv(pr, pi, qr, qi);
  }
  const ur = tr * tr - ti * ti, ui = 2 * tr * ti;
  const P = [1.320522, 35.76683, 219.0313, 1540.787, 3321.9905, 36183.31];
  const Q = [1.841439, 61.57037, 364.2191, 2186.181, 9022.228, 24322.84, 32066.6];
  let pr = 0.56419, pi = 0;
  for (const c of P) { const r = c - (ur * pr - ui * pi); pi = -(ur * pi + ui * pr); pr = r; }
  let qr = 1, qi = 0;
  for (const c of Q) { const r = c - (ur * qr - ui * qi); qi = -(ur * qi + ui * qr); qr = r; }
  const [fr, fi] = cdiv(pr, pi, qr, qi);
  const tfr = tr * fr - ti * fi, tfi = tr * fi + ti * fr;
  const eu = Math.exp(ur);
  return [eu * Math.cos(ui) - tfr, eu * Math.sin(ui) - tfi];
}
A.faddeeva = faddeeva;

// spherical-wave reflection coefficient Q (e^{-iwt} convention)
A.sphericalQ = function (k, r2, sinT, Zr, Zi) {
  const d = Zr * Zr + Zi * Zi, br = Zr / d, bi = -Zi / d; // admittance beta = 1/Z
  const dr = sinT + br, di = bi;
  const [Rr, Ri] = cdiv(sinT - br, -bi, dr, di); // plane-wave coefficient
  const s = 0.5 * Math.sqrt(k * r2);
  const wr = s * (dr - di), wi = s * (dr + di); // numerical distance w = (1+i)/2 sqrt(k r2) (sinT + beta)
  const [Wr, Wi] = faddeeva(wr, wi);
  const pr = wr * Wr - wi * Wi, pi = wr * Wi + wi * Wr;
  const sp = Math.sqrt(Math.PI);
  const Fr = 1 - sp * pi, Fi = sp * pr; // boundary-loss factor F = 1 + i sqrt(pi) w W(w)
  const ar = 1 - Rr, ai = -Ri;
  return [Rr + ar * Fr - ai * Fi, Ri + ar * Fi + ai * Fr];
};

// ------------------------------------------------------------------ barriers
A.kurzeAnderson = function (N) {
  if (N <= -0.2) return 0;
  if (N < 0) { const x = Math.sqrt(-TAU * N); return Math.max(0, 5 + 20 * Math.log10(x / Math.tan(x))); }
  if (N === 0) return 5;
  const x = Math.sqrt(TAU * N);
  return Math.min(20, 5 + 20 * Math.log10(x / Math.tanh(x)));
};

// intersection of segment P->Q with segment A->B (strictly inside P->Q)
function segX(px, py, qx, qy, ax, ay, bx, by) {
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const wx = ax - px, wy = ay - py;
  const t = (wx * sy - wy * sx) / den, u = (wx * ry - wy * rx) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u < 0 || u > 1) return null;
  return t;
}
A.segX = segX;

// barriers crossed by the 3D path S -> L, each with its path-length difference over the top
function crossings(scene, sx, sy, sz, lx, ly, lz, skip) {
  const out = [];
  const dh = Math.hypot(lx - sx, ly - sy);
  const bs = scene.barriers;
  for (let i = 0; i < bs.length; i++) {
    if (i === skip) continue;
    const b = bs[i];
    const t = segX(sx, sy, lx, ly, b.ax, b.ay, b.bx, b.by);
    if (t === null) continue;
    const d1 = t * dh, d2 = (1 - t) * dh;
    let delta = Math.hypot(d1, b.h - sz) + Math.hypot(d2, b.h - lz) - Math.hypot(dh, sz - lz);
    if (sz + (lz - sz) * t > b.h) delta = -delta; // line of sight passes above the edge
    out.push({ t, h: b.h, tl: b.tl, delta, px: sx + (lx - sx) * t, py: sy + (ly - sy) * t, kind: b.kind });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
A.crossings = crossings;

function barrierG2(cr, f, c) {
  let g2 = 1;
  for (const b of cr) {
    const Ad = A.kurzeAnderson(2 * b.delta * f / c);
    g2 *= Math.min(1, Math.pow(10, -Ad / 10) + Math.pow(10, -b.tl / 10));
  }
  return Math.max(g2, 1e-4);
}
A.barrierG2 = barrierG2;

// ------------------------------------------------------------------ sources
function spreadGain(s, f, r, c) {
  r = Math.max(r, 1);
  if (s.type !== 'line') return 1 / r;
  const Le = 0.35 * s.L; // straight long-throw section of a J-shaped array
  const rt = Math.max(1, Le * Le * f / (2 * c)); // near field of a line source
  return r < rt ? 1 / Math.sqrt(r) : rt / (Math.sqrt(rt) * r);
}

function dirMax(s, f) {
  switch (s.type) {
    case 'sub': return 1;
    case 'subc': return 15;
    case 'line': return 2 + 28 * clamp(Math.log2(f / 100) / Math.log2(40), 0, 1);
    default: return 2 + 38 * clamp(Math.log2(f / 150) / Math.log2(30), 0, 1);
  }
}
function dirDb(s, f, cosA) {
  return -Math.min(30, dirMax(s, f) * (1 - cosA) / 2);
}
// directivity factor for the reverberant power (rough)
function dirQ(s, f) {
  return Math.pow(10, 0.45 * dirMax(s, f) / 10);
}

// refraction: shadow zone for upward bending, gain for downward bending (dB)
function refractDb(f, d, hs, hr, a, c) {
  if (a < -1e-4) {
    const rs = Math.sqrt(2 * c / -a) * (Math.sqrt(Math.max(hs, 0.1)) + Math.sqrt(Math.max(hr, 0.1)));
    const x = d / rs - 0.8;
    if (x <= 0) return 0;
    const cap = 10 + 15 * clamp(Math.log2(f / 125) / 6, 0, 1);
    return -Math.min(cap, 12 * x * Math.cbrt(f / 500));
  }
  if (a > 1e-4) {
    const R = c / a;
    return Math.min(5, 2.5 * Math.log2(1 + d * d / (4 * R * (hs + hr))));
  }
  return 0;
}
A.shadowDistance = function (a, c, hs, hr) {
  if (a >= -1e-4) return Infinity;
  return Math.sqrt(2 * c / -a) * (Math.sqrt(hs) + Math.sqrt(hr));
};

function targetDb(f) {
  let db = 10 / (1 + Math.pow(f / 90, 2));
  db -= 3 * clamp(Math.log2(f / 2000) / 3, 0, 1);
  db += 10 * Math.log10(1 / (1 + Math.pow(30 / f, 8)));
  db += 10 * Math.log10(1 / (1 + Math.pow(f / 18000, 8)));
  return db;
}
const lr4lp = (f, fc) => 1 / (1 + Math.pow(f / fc, 4));
const lr4hp = (f, fc) => { const x = Math.pow(f / fc, 4); return x / (1 + x); };

// ------------------------------------------------------------------ geometry helpers
A.pointInPoly = function (poly, x, y) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};
A.inAudience = function (scene, x, y) {
  const a = scene.audience;
  if (a.type === 'rect') return x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1;
  const u = (x - a.cx) / a.rx, v = (y - a.cy) / a.ry;
  return u * u + v * v <= 1 && y >= a.ymin;
};
A.insideVenue = (scene, x, y) => A.pointInPoly(scene.poly, x, y);
A.distToAudience = function (scene, x, y) {
  const a = scene.audience;
  if (A.inAudience(scene, x, y)) return 0;
  if (a.type === 'rect') {
    const dx = Math.max(a.x0 - x, 0, x - a.x1), dy = Math.max(a.y0 - y, 0, y - a.y1);
    return Math.hypot(dx, dy);
  }
  const ang = Math.atan2((y - a.cy) / a.ry, (x - a.cx) / a.rx);
  const ex = a.cx + a.rx * Math.cos(ang), ey = Math.max(a.ymin, a.cy + a.ry * Math.sin(ang));
  return Math.hypot(x - ex, y - ey);
};
A.segCrossesPoly = function (poly, ax, ay, bx, by) {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (segX(ax, ay, bx, by, p[0], p[1], q[0], q[1]) !== null) return true;
  }
  return false;
};

function addBox(scene, cx, cy, w, d, h, tl, kind, refl) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - d / 2, y1 = cy + d / 2;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    const bid = scene.barriers.length;
    scene.barriers.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1], h, tl, kind });
    if (refl) scene.reflectors.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1], h, type: refl, bid });
  }
  return pts;
}

function envGeometry(scene, env) {
  const [xmin, ymin, xmax, ymax] = scene.bbox;
  const ym = (ymin + ymax) / 2;
  const dr = scene.draw;
  const bld = (cx, cy, w, d, h) => dr.buildings.push({ pts: addBox(scene, cx, cy, w, d, h, 40, 'building', 'hard'), h });
  const line = (ax, ay, bx, by, h, type, tl, list) => {
    const bid = tl != null ? scene.barriers.length : -1;
    if (tl != null) scene.barriers.push({ ax, ay, bx, by, h, tl, kind: type });
    scene.reflectors.push({ ax, ay, bx, by, h, type, bid });
    list.push([ax, ay, bx, by]);
  };
  switch (env) {
    case 'urban':
      bld(xmin - 95, ym - 40, 50, 120, 45);
      bld(xmin - 95, ym + 130, 50, 90, 35);
      bld(0, ymin - 110, 160, 50, 55);
      bld(200, ymin - 115, 90, 60, 40);
      bld(xmin - 70, ymax + 140, 80, 60, 30);
      bld(xmax + 230, ymin + 30, 60, 110, 60);
      break;
    case 'suburban':
      line(xmin - 40, ymax + 60, xmax + 60, ymax + 60, 15, 'trees', 3, dr.trees);
      line(xmin - 40, ymin - 40, xmin - 40, ymax + 60, 15, 'trees', 3, dr.trees);
      bld(xmax + 200, ymax + 160, 80, 50, 12);
      bld(xmin - 150, ymin + 20, 60, 60, 15);
      break;
    case 'mountain':
      line(-1600, ymin - 280, 1600, ymin - 280, 200, 'rock', null, dr.ridges);
      line(xmin - 330, -1500, xmin - 330, 1500, 150, 'rock', null, dr.ridges);
      line(xmax + 40, ymin - 40, xmax + 40, ymax + 40, 18, 'trees', 3, dr.trees);
      break;
    case 'seaside':
      dr.sea = [xmin - 140, -2000, xmin - 4000, 2000];
      break;
    case 'farmland':
      line(xmin - 60, ymax + 90, xmax + 120, ymax + 90, 3, 'trees', 2, dr.trees);
      line(xmax + 120, ymin - 60, xmax + 120, ymax + 90, 3, 'trees', 2, dr.trees);
      line(-1500, ymin - 650, 1500, ymin - 650, 60, 'rock', null, dr.ridges);
      break;
  }
}

A.reflCoef = function (type, f) {
  switch (type) {
    case 'hard': return 0.85;
    case 'stand': return 0.3;
    case 'fence': return 0.25;
    case 'rock': return 0.55 / (1 + f / 3000);
    case 'trees': return 0.25 * Math.min(1, Math.sqrt(f / 400)) / (1 + f / 6000);
  }
  return 0.5;
};

// ------------------------------------------------------------------ scene
A.buildScene = function (st, sr) {
  const V = A.VENUES[st.venue], S = A.SYSTEMS[st.system], R = A.REGIONS[st.region];
  const climate = A.climate(st);
  const gKey = climate.snow ? 'snow' : st.ground;
  const G = A.GROUNDS[gKey];
  const scene = {
    sr, st: Object.assign({}, st), venue: V, climate,
    ground: { key: gKey, name: G.name, sigma: G.sigma * (climate.wet && gKey !== 'snow' ? 3 : 1), step: G.step, color: G.color, overridden: gKey !== st.ground },
    env: R.env, barriers: [], reflectors: [], speakers: [],
    draw: { buildings: [], ridges: [], trees: [], sea: null },
  };
  // venue boundary
  let poly, gates, audDepth, audWidth;
  if (V.kind === 'field') {
    const x0 = -V.W / 2, x1 = V.W / 2, y0 = -V.back, y1 = V.D;
    poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const ys = (y1 - V.D * 0.55) / (y1 - y0);
    gates = [{ edge: 1, u: 1 - ys }, { edge: 3, u: ys }, { edge: 2, u: 0.28 }, { edge: 2, u: 0.72 }];
    scene.audience = { type: 'rect', x0: x0 + 6, x1: x1 - 6, y0: 6, y1: y1 - 6 };
    scene.center = [0, (y0 + y1) / 2];
    audDepth = V.D; audWidth = V.W;
  } else {
    const cy = V.fry + 5, n = 32;
    poly = [];
    for (let i = 0; i < n; i++) {
      const ph = TAU * i / n;
      poly.push([V.rx * Math.cos(ph), cy + V.ry * Math.sin(ph)]);
    }
    gates = [{ edge: 3, u: 0.5 }, { edge: 7, u: 0.5 }, { edge: 9, u: 0.5 }, { edge: 13, u: 0.5 }];
    scene.audience = { type: 'ellipse', cx: 0, cy, rx: V.frx, ry: V.fry, ymin: 8 };
    scene.center = [0, cy];
    audDepth = 2 * V.fry; audWidth = 2 * V.frx;
  }
  scene.poly = poly;
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  scene.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  scene.radius = Math.sqrt(Math.abs(area) / 2 / Math.PI);

  // gates (gaps in the fence) and walls
  const gap = 8;
  const wallH = V.kind === 'field' ? V.fenceH : V.wallH, wallTL = V.kind === 'field' ? V.fenceTL : V.wallTL;
  const wallKind = V.kind === 'field' ? 'fence' : 'stand';
  scene.gates = [];
  scene.walls = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const cuts = gates.filter(g => g.edge === i).map(g => g.u).sort((a, b) => a - b);
    let u0 = 0;
    const pieces = [];
    for (const u of cuts) {
      pieces.push([u0, u - gap / 2 / len]);
      u0 = u + gap / 2 / len;
      const gx = p[0] + (q[0] - p[0]) * u, gy = p[1] + (q[1] - p[1]) * u;
      let nx = (q[1] - p[1]) / len, ny = -(q[0] - p[0]) / len;
      if ((gx - scene.center[0]) * nx + (gy - scene.center[1]) * ny < 0) { nx = -nx; ny = -ny; }
      scene.gates.push({ x: gx, y: gy, nx, ny });
    }
    pieces.push([u0, 1]);
    // stadium entrances are tunnels under the stands: the wall still blocks sound there
    const tunnel = V.kind === 'stadium';
    let bid = -1;
    if (tunnel) {
      bid = scene.barriers.length;
      scene.barriers.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1], h: wallH, tl: wallTL, kind: wallKind });
    }
    for (const [ua, ub] of pieces) {
      if (ub <= ua) continue;
      const seg = { ax: p[0] + (q[0] - p[0]) * ua, ay: p[1] + (q[1] - p[1]) * ua, bx: p[0] + (q[0] - p[0]) * ub, by: p[1] + (q[1] - p[1]) * ub };
      if (!tunnel) {
        bid = scene.barriers.length;
        scene.barriers.push(Object.assign({ h: wallH, tl: wallTL, kind: wallKind }, seg));
      }
      scene.reflectors.push(Object.assign({ h: wallH, type: wallKind, bid }, seg));
      scene.walls.push(seg);
    }
  }
  // stage box: back and side walls
  const sw = V.stageW / 2;
  scene.stage = { x0: -sw, x1: sw, y0: -V.stageD, y1: 0, h: V.stageH };
  for (const [ax, ay, bx, by] of [[-sw, 0, -sw, -V.stageD], [-sw, -V.stageD, sw, -V.stageD], [sw, -V.stageD, sw, 0]]) {
    scene.barriers.push({ ax, ay, bx, by, h: V.stageH + 3, tl: 15, kind: 'stage' });
  }
  envGeometry(scene, R.env);

  // sound system
  scene.foh = [0, V.foh];
  const aimTo = (x, y, tx, ty) => { const d = Math.hypot(tx - x, ty - y); return [(tx - x) / d, (ty - y) / d]; };
  const mx = sw + 3;
  const aimY = audDepth * 0.55;
  const add = o => scene.speakers.push(Object.assign({ delay: 0, level: 1, hp: 0 }, o));
  for (const side of [-1, 1]) {
    const [ax, ay] = aimTo(side * mx, 0.5, side * mx * 0.3, aimY);
    add({ id: side < 0 ? 'mainL' : 'mainR', role: 'main', x: side * mx, y: 0.5, z: S.h, type: S.top, L: S.L,
      feed: side < 0 ? 'L' : 'R', ax, ay, ref: scene.foh, hp: 90 });
  }
  for (const side of [-1, 1]) {
    add({ id: side < 0 ? 'subL' : 'subR', role: 'sub', x: side * V.stageW * 0.25, y: 1.5, z: 0.8, type: S.subs, L: 0,
      feed: 'M', ax: 0, ay: 1, ref: scene.foh, lp: 90 });
  }
  for (const fr of S.towers) {
    const ty = fr * audDepth + (V.kind === 'stadium' ? 5 : 0);
    if (ty < 45) continue;
    const tx = Math.max(18, audWidth * 0.2);
    for (const side of [-1, 1]) {
      add({ id: (side < 0 ? 'towerL' : 'towerR') + Math.round(fr * 100), role: 'tower', x: side * tx, y: ty, z: 10, type: 'line', L: 3.5,
        feed: side < 0 ? 'L' : 'R', ax: 0, ay: 1, ref: [side * tx * 0.6, ty + 30], hp: 70, level: 0.6 });
    }
  }
  const c = climate.c;
  for (const s of scene.speakers) {
    if (s.role === 'main') continue;
    const main = scene.speakers.find(m => m.role === 'main' && (s.x < 0 ? m.x < 0 : m.x > 0));
    const dm = Math.hypot(s.ref[0] - main.x, s.ref[1] - main.y, A.LISTENER_Z - main.z);
    const ds = Math.hypot(s.ref[0] - s.x, s.ref[1] - s.y, A.LISTENER_Z - s.z);
    s.delay = Math.max(0, (dm - ds) / c + (s.role === 'tower' ? 0.010 : 0));
  }
  scene.tail = V.tail;
  scene.envP = A.ENVS[R.env];
  return scene;
};

// ------------------------------------------------------------------ frequency context
A.makeFreqCtx = function (scene, freqs) {
  const n = freqs.length, cl = scene.climate, c = cl.c;
  const fc = { f: Float64Array.from(freqs), n, k: new Float64Array(n), alpha: new Float64Array(n), Zg: [], Zc: [], eq: [] };
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    fc.k[i] = TAU * f / c;
    fc.alpha[i] = A.airAbsorption(f, cl.T, cl.RH, cl.p);
    fc.Zg.push(A.groundZ(f, scene.ground.sigma));
    fc.Zc.push(A.groundZ(f, A.CROWD.sigma));
  }
  const gain = scene.gain || 1;
  // system tuning: every box is equalised to the target curve at its reference point
  for (const s of scene.speakers) {
    const eq = new Float64Array(n);
    const dx = s.ref[0] - s.x, dy = s.ref[1] - s.y, dh = Math.hypot(dx, dy);
    const r = Math.hypot(dh, A.LISTENER_Z - s.z);
    const cosA = (dx * s.ax + dy * s.ay) / dh;
    for (let i = 0; i < n; i++) {
      const f = freqs[i];
      const raw = spreadGain(s, f, r, c) * db2a(-Math.min(12, fc.alpha[i] * r) + dirDb(s, f, cosA));
      let x = db2a(targetDb(f)) * s.level;
      if (s.hp) x *= lr4hp(f, s.hp);
      if (s.lp) x *= lr4lp(f, s.lp);
      eq[i] = gain * x / raw;
    }
    fc.eq.push(eq);
  }
  // reverberant field of the venue (Sabine with air absorption)
  const T = scene.tail;
  fc.rtV = new Float64Array(n); fc.prevIn = new Float64Array(n); fc.rtE = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    const shape = RT_SHAPE[clamp(Math.round(Math.log2(f / 63)), 0, 7)];
    const m = fc.alpha[i] / 4.343;
    const Ab = 0.161 * T.V / (T.RT * shape) + 4 * m * T.V;
    fc.rtV[i] = 0.161 * T.V / Ab;
    let w = 0;
    scene.speakers.forEach((s, si) => { w += fc.eq[si][i] * fc.eq[si][i] * 16 * Math.PI / dirQ(s, f); });
    fc.prevIn[i] = T.scale * w / Ab;
    const RTe = scene.envP.RT * shape;
    fc.rtE[i] = 1 / (1 / RTe + 4 * m * 343 / 13.8);
  }
  return fc;
};

// ------------------------------------------------------------------ propagation
A.speakerPath = function (scene, fc, si, lx, ly, lz) {
  const s = scene.speakers[si], cl = scene.climate, c = cl.c, n = fc.n;
  const dx = lx - s.x, dy = ly - s.y;
  const dh = Math.max(0.05, Math.hypot(dx, dy));
  const r1 = Math.hypot(dh, lz - s.z);
  const cosA = (dx * s.ax + dy * s.ay) / dh;
  const a = cl.gradT + 0.04 * cl.wind * (cl.windDir[0] * dx + cl.windDir[1] * dy) / dh;
  const cr = crossings(scene, s.x, s.y, s.z, lx, ly, lz, -1);
  // ground reflection geometry: from the last diffracting edge if there is one
  let vx = s.x, vy = s.y, vz = s.z, dg = dh;
  if (cr.length) { const b = cr[cr.length - 1]; vx = b.px; vy = b.py; vz = b.h; dg = (1 - b.t) * dh; }
  const tr = vz / (vz + lz);
  const crowd = A.inAudience(scene, vx + (lx - vx) * tr, vy + (ly - vy) * tr);
  const plane = crowd ? A.CROWD.plane : 0;
  let hs = Math.max(0.05, vz - plane), hr = Math.max(0.05, lz - plane);
  if (a > 1e-4) { const hb = Math.min(10, dg * dg * a / (8 * c)); hs += hb / 2; hr += hb / 2; }
  const r1g = Math.hypot(dg, hs - hr), r2g = Math.hypot(dg, hs + hr), sinT = (hs + hr) / r2g;
  const Zs = crowd ? fc.Zc : fc.Zg;
  const mu2 = 2e-7 + 1.2e-7 * cl.wind * cl.wind;
  const out = {
    g: new Float64Array(n), gu: new Float64Array(n), ggR: new Float64Array(n), ggI: new Float64Array(n), C: new Float64Array(n),
    tau1: r1 / c + s.delay, tau2: (r1 + r2g - r1g) / c + s.delay, r1, dh, a, cr, crowd,
    src: cr.length ? [vx, vy, vz] : [s.x, s.y, s.z], img: [vx, vy, 2 * plane - vz],
  };
  const ratio = r1g / r2g;
  const dOut = A.distToAudience(scene, lx, ly);
  for (let i = 0; i < n; i++) {
    const f = fc.f[i];
    const base = fc.eq[si][i] * spreadGain(s, f, r1, c) * db2a(-fc.alpha[i] * r1 + dirDb(s, f, cosA) + refractDb(f, dh, s.z, lz, a, c) - A.miscDb(scene, f, dOut));
    out.gu[i] = base;
    const g = cr.length ? base * Math.sqrt(barrierG2(cr, f, c)) : base;
    out.g[i] = g;
    const q = A.sphericalQ(fc.k[i], r2g, sinT, Zs[i][0], Zs[i][1]);
    out.ggR[i] = g * ratio * q[0];
    out.ggI[i] = -g * ratio * q[1]; // conjugate: DSP convention e^{+iwt}
    out.C[i] = Math.exp(-fc.k[i] * fc.k[i] * mu2 * 1.1 * r1);
  }
  return out;
};

// first-order image sources from vertical walls
A.imagePaths = function (scene, fc, si, lx, ly, lz, out) {
  const s = scene.speakers[si], cl = scene.climate, c = cl.c, n = fc.n;
  const rs = scene.reflectors;
  for (let j = 0; j < rs.length; j++) {
    const w = rs[j];
    const ex = w.bx - w.ax, ey = w.by - w.ay;
    const cs = ex * (s.y - w.ay) - ey * (s.x - w.ax), cl_ = ex * (ly - w.ay) - ey * (lx - w.ax);
    if (cs * cl_ <= 0) continue;
    const len2 = ex * ex + ey * ey;
    const tp = ((s.x - w.ax) * ex + (s.y - w.ay) * ey) / len2;
    const mx = 2 * (w.ax + tp * ex) - s.x, my = 2 * (w.ay + tp * ey) - s.y;
    const t = segX(mx, my, lx, ly, w.ax, w.ay, w.bx, w.by);
    if (t === null) continue;
    const px = mx + (lx - mx) * t, py = my + (ly - my) * t, pz = s.z + (lz - s.z) * t;
    if (pz > w.h) continue;
    const dh = Math.hypot(lx - mx, ly - my), r = Math.hypot(dh, lz - s.z);
    const ddx = px - s.x, ddy = py - s.y, dd = Math.hypot(ddx, ddy) || 1;
    const cosA = (ddx * s.ax + ddy * s.ay) / dd;
    const cr = crossings(scene, s.x, s.y, s.z, px, py, pz, w.bid).concat(crossings(scene, px, py, pz, lx, ly, lz, w.bid));
    const a = cl.gradT + 0.04 * cl.wind * (cl.windDir[0] * (lx - mx) + cl.windDir[1] * (ly - my)) / dh;
    const g = new Float64Array(n);
    const dOut = A.distToAudience(scene, lx, ly);
    let any = 0;
    for (let i = 0; i < n; i++) {
      const f = fc.f[i];
      let v = fc.eq[si][i] * spreadGain(s, f, r, c) * A.reflCoef(w.type, f) *
        db2a(-fc.alpha[i] * r + dirDb(s, f, cosA) + refractDb(f, dh, s.z, lz, a, c) - A.miscDb(scene, f, dOut));
      if (cr.length) v *= Math.sqrt(barrierG2(cr, f, c));
      g[i] = v; any += v * v;
    }
    out.push({ si, g, e: any, tau: r / c + s.delay, src: [mx, my, s.z], refl: [px, py, pz] });
  }
};

// band energies (pressure^2 re the calibration) at a point
A.levelAt = function (scene, bctx, x, y, z, fast) {
  const nb = bctx.n, cl = scene.climate, c = cl.c;
  const Ed = new Float64Array(nb), Ei = new Float64Array(nb), Ev = new Float64Array(nb), Ee = new Float64Array(nb);
  let barrier1k = 0, mainPath = null;
  const i1k = 4;
  scene.speakers.forEach((s, si) => {
    const p = A.speakerPath(scene, bctx, si, x, y, z);
    if (s.id === 'mainL') mainPath = p;
    const dtau = p.tau2 - p.tau1;
    for (let i = 0; i < nb; i++) {
      const g = p.g[i], qr = p.ggR[i], qi = p.ggI[i];
      const w = TAU * bctx.f[i] * dtau, sincArg = 0.3536 * w;
      const sinc = sincArg < 1e-6 ? 1 : Math.sin(sincArg) / sincArg;
      const cross = 2 * p.C[i] * g * (qr * Math.cos(w) + qi * Math.sin(w)) * sinc;
      Ed[i] += Math.max(0.02 * g * g, g * g + qr * qr + qi * qi + cross);
    }
    if (s.role === 'main' && p.cr.length) barrier1k = Math.max(barrier1k, -10 * Math.log10(barrierG2(p.cr, bctx.f[i1k], c)));
  });
  if (!fast) {
    const imgs = [];
    scene.speakers.forEach((s, si) => A.imagePaths(scene, bctx, si, x, y, z, imgs));
    for (const im of imgs) for (let i = 0; i < nb; i++) Ei[i] += im.g[i] * im.g[i];
  }
  // venue reverberation, radiated out of the venue when outside
  const inside = A.insideVenue(scene, x, y);
  const [cx, cy] = scene.center;
  const dc = Math.hypot(x - cx, y - cy);
  let crV = null;
  if (!inside) crV = crossings(scene, cx, cy, scene.tail.hv, x, y, z, -1);
  const dOut = A.distToAudience(scene, x, y);
  for (let i = 0; i < nb; i++) {
    let v = bctx.prevIn[i] * Math.pow(10, -A.miscDb(scene, bctx.f[i], dOut) / 10);
    if (!inside) {
      v *= Math.min(1, Math.pow(scene.radius / dc, 2)) * barrierG2(crV, bctx.f[i], c) * Math.pow(10, -bctx.alpha[i] * Math.max(0, dc - scene.radius) / 10);
    }
    Ev[i] = v;
  }
  // diffuse field returned by the surroundings
  const de = Math.max(dc, scene.radius);
  for (let i = 0; i < nb; i++) {
    let w = 0;
    scene.speakers.forEach((s, si) => { w += bctx.eq[si][i] * bctx.eq[si][i]; });
    Ee[i] = scene.envP.kappa * w / (de * de) * Math.pow(10, (-bctx.alpha[i] * Math.max(0, dc - scene.radius) - 0.5 * A.miscDb(scene, bctx.f[i], dOut)) / 10);
  }
  const E = new Float64Array(nb);
  for (let i = 0; i < nb; i++) E[i] = Ed[i] + Ei[i] + Ev[i] + Ee[i];
  return { E, Ed, Ei, Ev, Ee, barrier1k, mainPath, inside };
};

A.dBA = function (E) {
  let s = 0;
  for (let i = 0; i < E.length; i++) s += E[i] * Math.pow(10, A.AWEIGHT[i] / 10);
  return 100 + 10 * Math.log10(Math.max(s, 1e-20));
};

A.prepareScene = function (scene) {
  scene.gain = 1;
  let bctx = A.makeFreqCtx(scene, A.BANDS);
  const L = A.levelAt(scene, bctx, scene.foh[0], scene.foh[1], A.LISTENER_Z, true);
  scene.gain = Math.pow(10, (100 - A.dBA(L.E)) / 20);
  bctx = A.makeFreqCtx(scene, A.BANDS);
  return bctx;
};

// ------------------------------------------------------------------ head
// Brown-Duda spherical head: complex shadow filter and delay for one ear
function headFilter(fc, ux, uy, uz, ex, ey, c, outR, outI) {
  const a = A.HEAD_RADIUS;
  const th = Math.acos(clamp(ux * ex + uy * ey, -1, 1));
  const amin = 0.1, thmin = 5 * Math.PI / 6;
  const alpha = (1 + amin / 2) + (1 - amin / 2) * Math.cos(th / thmin * Math.PI);
  const w0 = c / a;
  for (let i = 0; i < fc.n; i++) {
    const x = TAU * fc.f[i] / (2 * w0), d = 1 + x * x;
    outR[i] = (1 + alpha * x * x) / d;
    outI[i] = (alpha - 1) * x / d;
  }
  return th < Math.PI / 2 ? a / c * (1 - Math.cos(th)) : a / c * (1 + th - Math.PI / 2);
}

// ------------------------------------------------------------------ FFT
const fftCache = {};
function fftPlan(N) {
  if (fftCache[N]) return fftCache[N];
  const rev = new Uint32Array(N), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(TAU * i / N); sin[i] = Math.sin(TAU * i / N); }
  return (fftCache[N] = { rev, cos, sin });
}
// in-place inverse DFT (e^{+i}), unscaled
function ifft(re, im) {
  const N = re.length, { rev, cos, sin } = fftPlan(N);
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const h = size >> 1, step = N / size;
    for (let st = 0; st < N; st += size) {
      for (let k = 0; k < h; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = st + k, b = a + h;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}
A.ifft = ifft;

// ------------------------------------------------------------------ IR synthesis
A.coarseFreqs = function (sr, K) {
  const f0 = 10, f1 = sr / 2, out = [];
  for (let k = 0; k < K; k++) out.push(f0 * Math.pow(f1 / f0, k / (K - 1)));
  return out;
};

function binMap(fc, N, sr, cache) {
  const key = N + ':' + sr + ':' + fc.n;
  if (cache.binKey === key) return cache.bin;
  const half = N / 2, K = fc.n, f0 = fc.f[0], f1 = fc.f[K - 1];
  const idx = new Int32Array(half + 1), frac = new Float64Array(half + 1);
  const lr = Math.log(f1 / f0);
  for (let b = 0; b <= half; b++) {
    const f = b * sr / N;
    let pos = f <= f0 ? 0 : Math.log(f / f0) / lr * (K - 1);
    pos = clamp(pos, 0, K - 1.000001);
    idx[b] = Math.min(K - 2, Math.floor(pos));
    frac[b] = pos - idx[b];
  }
  cache.binKey = key;
  cache.bin = { idx, frac };
  return cache.bin;
}

function addPair(accR, accI, dR, dI, gR, gI, C, t1, t2, bm, half, N, sr) {
  const w1 = -TAU * t1 * sr / N, w2 = -TAU * t2 * sr / N;
  const c1 = Math.cos(w1), s1 = Math.sin(w1), c2 = Math.cos(w2), s2 = Math.sin(w2);
  let p1r = 1, p1i = 0, p2r = 1, p2i = 0;
  const idx = bm.idx, frac = bm.frac;
  for (let b = 0; b <= half; b++) {
    const k = idx[b], u = frac[b], v = 1 - u;
    const dr = dR[k] * v + dR[k + 1] * u, di = dI[k] * v + dI[k + 1] * u;
    const gr = gR[k] * v + gR[k + 1] * u, gi = gI[k] * v + gI[k + 1] * u;
    const cc = C[k] * v + C[k + 1] * u;
    const Dr = dr * p1r - di * p1i, Di = dr * p1i + di * p1r;
    const Gr = gr * p2r - gi * p2i, Gi = gr * p2i + gi * p2r;
    let hr = Dr + cc * Gr, hi = Di + cc * Gi;
    const e = hr * hr + hi * hi, inc = (1 - cc * cc) * (gr * gr + gi * gi);
    if (inc > 0 && e > 1e-30) { const sc = Math.min(4, Math.sqrt((e + inc) / e)); hr *= sc; hi *= sc; }
    accR[b] += hr; accI[b] += hi;
    let t = p1r * c1 - p1i * s1; p1i = p1r * s1 + p1i * c1; p1r = t;
    t = p2r * c2 - p2i * s2; p2i = p2r * s2 + p2i * c2; p2r = t;
  }
}

function addSingle(accR, accI, gR, gI, t1, bm, half, N, sr) {
  const w1 = -TAU * t1 * sr / N, c1 = Math.cos(w1), s1 = Math.sin(w1);
  let pr = 1, pi = 0;
  const idx = bm.idx, frac = bm.frac;
  for (let b = 0; b <= half; b++) {
    const k = idx[b], u = frac[b], v = 1 - u;
    const gr = gR[k] * v + gR[k + 1] * u, gi = gI[k] * v + gI[k + 1] * u;
    accR[b] += gr * pr - gi * pi; accI[b] += gr * pi + gi * pr;
    const t = pr * c1 - pi * s1; pi = pr * s1 + pi * c1; pr = t;
  }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// octave-band noise, unit variance, 4 decorrelated channels per band
function bandNoise(N, sr, cache) {
  const key = N + ':' + sr;
  if (cache.noiseKey === key) return cache.noise;
  const rnd = mulberry32(12345);
  const out = A.BANDS.map(fb => {
    const chs = [];
    for (let ch = 0; ch < 4; ch++) {
      const x = new Float32Array(N);
      for (let i = 0; i < N; i++) x[i] = rnd() * 2 - 1;
      if (fb < sr / 2.2) {
        for (let pass = 0; pass < 2; pass++) biquadBP(x, fb, 1.414, sr);
      }
      let e = 0;
      for (let i = 0; i < N; i++) e += x[i] * x[i];
      const g = 1 / Math.sqrt(e / N || 1);
      for (let i = 0; i < N; i++) x[i] *= g;
      chs.push(x);
    }
    return chs;
  });
  cache.noiseKey = key;
  cache.noise = out;
  return out;
}

function biquadBP(x, f0, Q, sr) {
  const w = TAU * f0 / sr, al = Math.sin(w) / (2 * Q), cw = Math.cos(w);
  const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
}

function addTail(out, noise, E, RT, onset, sr, N, offset) {
  for (let b = 0; b < A.BANDS.length; b++) {
    const fb = A.BANDS[b];
    if (fb >= sr / 2.2 || !(E[b] > 0)) continue;
    const Bw = 0.7071 * fb;
    const et = E[b] * Bw / (sr / 2) / 2; // energy per output channel
    const q = Math.exp(-6.91 / (RT[b] * sr));
    const n0 = Math.floor(onset * sr);
    const len = N - n0;
    if (len <= 0) continue;
    const rise = Math.max(1, Math.floor(0.008 * sr));
    const sumE = (1 - Math.pow(q * q, len)) / (1 - q * q);
    const amp = Math.sqrt(et / sumE);
    for (let ch = 0; ch < 4; ch++) {
      const nz = noise[b][ch], o = out[ch];
      let env = amp;
      for (let i = 0; i < len; i++) {
        const r = i < rise ? i / rise : 1;
        o[n0 + i] += env * r * nz[(i + offset) % N];
        env *= q;
        if (env < amp * 1e-4) break;
      }
    }
  }
}

A.IR_K = 128;

// full impulse response for a listener (4 channels: L->L, L->R, R->L, R->R)
A.synthIR = function (scene, cctx, bctx, lx, ly, lz, hx, hy, N, cache) {
  const sr = scene.sr, half = N / 2, c = scene.climate.c, K = cctx.n;
  const bm = binMap(cctx, N, sr, cache);
  const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
  const ears = [[hy, -hx], [-hy, hx]]; // left, right
  const feeds = { L: 0, R: 1, M: 2 };
  const acc = [];
  for (let f = 0; f < 3; f++) acc.push([0, 1].map(() => [new Float64Array(half + 1), new Float64Array(half + 1)]));

  const level = A.levelAt(scene, bctx, lx, ly, lz, false);
  const sp = scene.speakers.map((s, si) => A.speakerPath(scene, cctx, si, lx, ly, lz));
  let imgs = [];
  scene.speakers.forEach((s, si) => A.imagePaths(scene, cctx, si, lx, ly, lz, imgs));
  imgs.sort((a, b) => b.e - a.e);
  imgs = imgs.slice(0, 40);
  let tmin = Infinity;
  for (const p of sp) tmin = Math.min(tmin, p.tau1);
  for (const p of imgs) tmin = Math.min(tmin, p.tau);
  const pre = 0.01, tmax = N / sr - 0.06;
  const hR = new Float64Array(K), hI = new Float64Array(K), h2R = new Float64Array(K), h2I = new Float64Array(K);
  const dR = new Float64Array(K), dI = new Float64Array(K), gR = new Float64Array(K), gI = new Float64Array(K);
  const dir = p => { const vx = p[0] - lx, vy = p[1] - ly, vz = p[2] - lz, d = Math.hypot(vx, vy, vz) || 1; return [vx / d, vy / d, vz / d]; };

  sp.forEach((p, si) => {
    const s = scene.speakers[si];
    const t1 = p.tau1 - tmin + pre, t2 = p.tau2 - tmin + pre;
    if (t1 > tmax) return;
    const u1 = dir(p.src), u2 = dir(p.img);
    for (let e = 0; e < 2; e++) {
      const d1 = headFilter(cctx, u1[0], u1[1], u1[2], ears[e][0], ears[e][1], c, hR, hI);
      const d2 = headFilter(cctx, u2[0], u2[1], u2[2], ears[e][0], ears[e][1], c, h2R, h2I);
      for (let k = 0; k < K; k++) {
        dR[k] = p.g[k] * hR[k]; dI[k] = p.g[k] * hI[k];
        gR[k] = p.ggR[k] * h2R[k] - p.ggI[k] * h2I[k];
        gI[k] = p.ggR[k] * h2I[k] + p.ggI[k] * h2R[k];
      }
      const a = acc[feeds[s.feed]][e];
      addPair(a[0], a[1], dR, dI, gR, gI, p.C, t1 + d1, t2 + d2, bm, half, N, sr);
    }
  });
  for (const im of imgs) {
    const t1 = im.tau - tmin + pre;
    if (t1 > tmax) continue;
    const s = scene.speakers[im.si];
    const u = dir(im.src);
    for (let e = 0; e < 2; e++) {
      const d1 = headFilter(cctx, u[0], u[1], u[2], ears[e][0], ears[e][1], c, hR, hI);
      for (let k = 0; k < K; k++) { dR[k] = im.g[k] * hR[k]; dI[k] = im.g[k] * hI[k]; }
      const a = acc[feeds[s.feed]][e];
      addSingle(a[0], a[1], dR, dI, t1 + d1, bm, half, N, sr);
    }
  }

  // frequency response at both ears for a mono input (1/6 octave)
  const fr = { f: [], l: [], r: [] };
  for (let f = 20; f <= Math.min(20000, sr / 2); f *= Math.pow(2, 1 / 6)) {
    const b0 = Math.max(1, Math.floor(f * Math.pow(2, -1 / 12) * N / sr)), b1 = Math.min(half, Math.ceil(f * Math.pow(2, 1 / 12) * N / sr));
    const sum = [0, 0];
    for (let e = 0; e < 2; e++) {
      for (let b = b0; b <= b1; b++) {
        let re = 0, im = 0;
        for (let fd = 0; fd < 3; fd++) { re += acc[fd][e][0][b]; im += acc[fd][e][1][b]; }
        sum[e] += re * re + im * im;
      }
      sum[e] /= (b1 - b0 + 1);
    }
    fr.f.push(f); fr.l.push(100 + 10 * Math.log10(sum[0] + 1e-20)); fr.r.push(100 + 10 * Math.log10(sum[1] + 1e-20));
  }

  // channel spectra -> time domain (two real IFFTs packed in one complex IFFT each)
  const chans = [];
  const spec = (inFeed, e, b, part) => acc[inFeed][e][part][b] + 0.5 * acc[2][e][part][b];
  for (const inFeed of [0, 1]) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let b = 0; b <= half; b++) {
      const aR = spec(inFeed, 0, b, 0), aI = spec(inFeed, 0, b, 1); // to left ear
      const cR = spec(inFeed, 1, b, 0), cI = spec(inFeed, 1, b, 1); // to right ear
      // Z = A + iC
      re[b] = aR - cI; im[b] = aI + cR;
      if (b > 0 && b < half) { re[N - b] = aR + cI; im[N - b] = -aI + cR; }
    }
    ifft(re, im);
    const l = new Float32Array(N), r = new Float32Array(N);
    for (let i = 0; i < N; i++) { l[i] = re[i] / N; r[i] = im[i] / N; }
    chans.push(l, r);
  }
  // reverberant tails
  const noise = bandNoise(N, sr, cache);
  const onsetV = pre + Math.max(0, (level.inside ? 0 : 0)) + scene.tail.onset;
  addTail(chans, noise, level.Ev, bctx.rtV, onsetV, sr, N, 0);
  addTail(chans, noise, level.Ee, bctx.rtE, pre + scene.envP.onset, sr, N, Math.floor(N / 3));
  // fade out the last 40 ms to hide any circular wrap
  const nf = Math.floor(0.04 * sr);
  for (const ch of chans) for (let i = 0; i < nf; i++) ch[N - 1 - i] *= i / nf;

  return { chans, level, fr, nImages: imgs.length };
};

root.Acoustics = A;
})(typeof self !== 'undefined' ? self : globalThis);
