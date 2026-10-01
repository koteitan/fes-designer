# Fes Designer

野外ライブを「会場の外から聴いている」音を、屋外音響シミュレーションで作る Web アプリです。

**▶ https://koteitan.github.io/fes-designer/**

会場の外から歩いて近づき、ゲートを通って自分の席に着くまで、聞こえ方が変わっていきます。

## 使い方

1. 会場の規模、サウンドシステム、地面、地域 (ワールドツアーでよく行く世界の都市 + 自然の中のフェス会場、44 か所)、月、時間帯、天気、風向きを選ぶ
2. ▶ 再生 → 🚶 歩く
3. 地図の **S** (スタート) と **席** はドラッグで動かせます。道の上をクリックするとそこへ移動します
4. 音声ファイルを選ぶ (またはページにドロップ) と、その曲で聴けます

## 計算していること

- 気候: 地域の月平均気温・湿度 → 時間帯・天気で気温を動かし、水蒸気圧を保って湿度を再計算。標高から気圧
- 空気吸収: ISO 9613-1
- 地面: Delany–Bazley インピーダンス + 球面波反射係数 (Faddeeva 関数)。観客エリアは頭の高さの吸音面
- 柵・スタンド・ビル: Kurze–Anderson 回折 + 透過損失
- ラインアレイ (J 型の上部だけが円筒波)、サブのカーディオイド、ディレイタワーの時間合わせ
- 客席より外の散乱 (木・建物・車・屋台。ISO 9613-2 付属書 A)
- FOH でのシステム EQ と校正 (FOH = 100 dB(A))
- 風と気温勾配による屈折 (影領域 / 逆転層)、乱流による干渉のぼけと音量のゆらぎ
- ビル・スタンド・山・木立の 1 次鏡像音源、会場と周辺の残響
- Brown–Duda 球頭モデル (両耳)
- 以上から 4ch インパルス応答 (L→左耳, L→右耳, R→左耳, R→右耳) を作り、歩くたびに更新して畳み込み

ビルドは不要です (index.html + JS + CSS)。

---

A web app that simulates how an outdoor festival sounds from outside the venue, using outdoor/architectural acoustics models (ISO 9613-1 air absorption, Delany–Bazley ground, Kurze–Anderson barriers, refraction, turbulence, image sources, reverberant tails, spherical-head binaural rendering). Walk from outside the venue to your seat.
