/* ==========================================================================
   코코백업 — 동작 스크립트
   --------------------------------------------------------------------------
   전체 흐름
     1) 사용자가 "스타일 HTML"(코코포리아에서 내보낸 HTML)을 올리면
        그 안의 <style> CSS, 제목, 아바타(스탠딩 이미지) 정보를 뽑아 둔다.
     2) "로그 JSON"을 올리면 메시지 목록과 채널 목록을 읽는다.
     3) 사용자가 채널·글꼴·제목을 고를 때마다
        [원본 CSS + 정렬 CSS + 글꼴 CSS] + [선택한 채널의 메시지]로
        결과 HTML을 새로 만들어 미리보기(iframe)에 띄운다.
     4) "HTML 다운로드"를 누르면 그 결과를 파일로 저장한다.

   모든 처리는 브라우저 안에서만 일어나고, 파일은 어디에도 업로드되지 않는다.

   전체 코드를 (() => { ... })() 로 감싸서 변수들이 전역(window)에 새지 않게 했다.
   ========================================================================== */
(() => {
  "use strict";   // 흔한 실수(선언 안 한 변수 사용 등)를 오류로 잡아 줌

  // ── 상태 ──────────────────────────────────────────────────────────────
  // 화면에 영향을 주는 값은 전부 여기 모아 둔다.
  // 값이 바뀌면 render()를 불러서 결과를 다시 만든다.
  const state = {
    css: "",            // 원본 HTML의 <style> 내용을 이어 붙인 것
    htmlTitle: "",      // 원본 HTML의 제목 (대괄호 부분 제거)
    htmlAvatars: [],    // 원본 HTML에서 뽑은 [메시지 시간(ms), "avatar-image-N"] 목록
    baseAvatars: null,  // 아이콘 해시 → 원본 클래스 대응표 (캐시. HTML/JSON이 바뀌면 null로 비움)
    log: null,          // JSON 내용 { messages: [...], images: { 해시: dataURL } }
    channels: [],       // [{ id, name, count }]  채널 목록과 메시지 수
    selected: new Set(),// 체크된 채널 id들
    blob: null,         // 마지막으로 만든 결과 HTML (다운로드에 그대로 사용)
    previewUrl: null,   // blob을 가리키는 임시 주소 (iframe·다운로드 링크에 사용)
    font: "",           // 글꼴 선택값: "" = 원본 그대로 / "lib:Pretendard:400" / "up:0"
    uploads: [],        // 사용자가 올린 글꼴 [{ label, family, src(dataURL), format }]
  };

  // 자주 쓰는 DOM 요소를 한 번만 찾아서 보관
  const $ = (id) => document.getElementById(id);
  const el = {
    fileHtml: $("file-html"), dropHtml: $("drop-html"), metaHtml: $("meta-html"),
    fileJson: $("file-json"), dropJson: $("drop-json"), metaJson: $("meta-json"),
    channels: $("channels"), selAll: $("sel-all"), selNone: $("sel-none"),
    title: $("title"), download: $("download"), status: $("status"),
    frame: $("frame"), empty: $("empty"), count: $("count"),
    font: $("font"),
    fileFont: $("file-font"), dropFont: $("drop-font"), metaFont: $("meta-font"),
  };

  const MAIN = "main";
  // 결과 파일에서 [채널 이름] 표시를 붙이지 않는 채널
  const NO_LABEL = new Set([MAIN, "info"]);
  // JSON이 없을 때 채널 목록 자리에 보여 줄 안내 문구
  const EMPTY_CHANNELS = '<li class="channels-empty">JSON을 올리면 채널이 여기 나타납니다.</li>';


  // ── 글꼴 ──────────────────────────────────────────────────────────────
  // 기본 제공 글꼴 목록.
  // files 배열의 순서가 곧 굵기다: 0번째 = 100(Thin), 3번째 = 400(Regular) ...
  // 선택칸에는 "Pretendard4"처럼 이름 뒤에 굵기 번호(400 → 4)를 붙여 보여 준다.
  // 새 글꼴을 추가하려면 같은 모양으로 항목을 하나 더 넣으면 된다.
  const FONT_LIBRARY = [
    {
      family: "Pretendard",
      base: "https://cdn.jsdelivr.net/gh/projectnoonnu/pretendard@1.0/Pretendard-",
      files: ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"],
    },
    {
      family: "Paperozi",
      base: "https://cdn.jsdelivr.net/gh/projectnoonnu/2408-3@1.0/Paperlogy-",
      files: ["1Thin", "2ExtraLight", "3Light", "4Regular", "5Medium", "6SemiBold", "7Bold", "8ExtraBold", "9Black"],
    },
  ];

  // 파일 확장자 → CSS @font-face의 format() 이름
  const FONT_FORMATS = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

  // 기본 제공 글꼴의 @font-face를 굵기 9개 모두 만든다.
  // ⚠ 고른 굵기 하나만 넣으면 안 된다. 원본 CSS가 이름(.speaker) 등에 bold를 쓰는데,
  //    700 굵기가 없으면 브라우저가 가짜로 굵게 만들어서 모양이 달라진다.
  //    브라우저는 실제로 화면에 쓰이는 굵기의 파일만 내려받으므로 9개를 다 적어도 손해가 없다.
  function libraryFaces(family) {
    const lib = FONT_LIBRARY.find((f) => f.family === family);
    if (!lib) return "";
    return lib.files.map((name, i) => `@font-face {
  font-family: '${lib.family}';
  src: url('${lib.base}${name}.woff2') format('woff2');
  font-weight: ${(i + 1) * 100};
  font-display: swap;
}`).join("\n");
  }

  // 사용자가 올린 글꼴의 @font-face.
  // 글꼴 파일을 dataURL(base64 문자열)로 통째로 넣기 때문에 결과 HTML 하나만 있어도 글꼴이 보인다.
  // 파일 하나에 굵기가 하나뿐이므로 100~900 모든 굵기에 같은 파일을 쓰게 한다.
  function uploadFace(u) {
    return `@font-face {
  font-family: '${u.family}';
  src: url('${u.src}') format('${u.format}');
  font-weight: 100 900;
  font-display: swap;
}`;
  }

  // 현재 글꼴 선택값을 해석해서 { family(글꼴 이름), weight(본문 굵기), faces(@font-face CSS) }를 돌려준다.
  // "원본 HTML 글꼴"을 골랐으면 null → 글꼴 CSS를 아예 넣지 않는다.
  function currentFont() {
    const v = state.font;
    if (v.startsWith("lib:")) {
      // "lib:Pretendard:700" → family = "Pretendard", weight = 700
      const [, family, w] = v.split(":");
      const weight = Number(w);
      return { family, weight, faces: libraryFaces(family) };
    }
    if (v.startsWith("up:")) {
      // "up:2" → 업로드한 글꼴 중 2번
      const u = state.uploads[Number(v.slice(3))];
      if (u) return { family: u.family, weight: 400, faces: uploadFace(u) };
    }
    return null;
  }

  // 04 글꼴 선택칸(<select>)의 항목을 다시 그린다.
  // 기본 글꼴은 글꼴별 묶음(optgroup)으로, 업로드한 글꼴은 맨 아래 별도 묶음으로.
  function renderFontSelect() {
    const opt = (value, label) =>
      `<option value="${esc(value)}"${value === state.font ? " selected" : ""}>${esc(label)}</option>`;
    let html = opt("", "원본 HTML 글꼴 (변경 안 함)");
    for (const lib of FONT_LIBRARY) {
      html += `<optgroup label="${esc(lib.family)}">`;
      lib.files.forEach((_, i) => { html += opt(`lib:${lib.family}:${(i + 1) * 100}`, `${lib.family}${i + 1}`); });
      html += "</optgroup>";
    }
    if (state.uploads.length) {
      html += `<optgroup label="업로드한 글꼴">`;
      state.uploads.forEach((u, i) => { html += opt(`up:${i}`, u.label); });
      html += "</optgroup>";
    }
    el.font.innerHTML = html;
  }

  // 파일을 dataURL("data:font/ttf;base64,....") 문자열로 읽는다. 실패하면 null.
  const readDataUrl = (file) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(file);
  });

  // 글꼴 파일(여러 개 가능)을 읽어서 업로드 목록에 추가한다.
  async function loadFonts(files) {
    // 하나씩 차례로 기다리지 않고 동시에 읽는다 (Promise.all)
    const results = await Promise.all(files.map(async (file) => {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const format = FONT_FORMATS[ext];
      // 지원하지 않는 확장자는 읽지 않고 실패 처리
      const src = format ? await readDataUrl(file) : null;
      return { file, format, src };
    }));

    const added = [];
    const failed = [];
    for (const { file, format, src } of results) {
      if (!src) { failed.push(file.name); continue; }
      const label = file.name.replace(/\.[^.]+$/, "");   // 확장자 뺀 파일 이름
      // 글꼴 안의 실제 이름과 겹치지 않도록 CocoUpload0, CocoUpload1 ... 로 따로 이름을 붙인다
      state.uploads.push({ label, family: `CocoUpload${state.uploads.length}`, src, format });
      added.push(label);
    }
    // 새로 올린 글꼴이 있으면 마지막 것을 바로 선택해 준다
    if (added.length) state.font = `up:${state.uploads.length - 1}`;
    renderFontSelect();

    // 드롭존에 결과 표시: 전부 실패면 오류, 하나라도 성공이면 성공(+실패 목록)
    if (failed.length && !added.length) {
      markDrop(el.dropFont, el.metaFont, "글꼴 파일 업로드", `읽지 못했어요: ${failed.join(", ")}`, "is-error");
    } else {
      markDrop(el.dropFont, el.metaFont, added.join(", "),
        `업로드한 글꼴 ${state.uploads.length}개${failed.length ? ` · 실패: ${failed.join(", ")}` : ""}`, "is-loaded");
    }
    render();
  }


  // ── 도우미 함수 ──────────────────────────────────────────────────────

  // HTML 특수문자 바꾸기.
  // 채팅 내용에 < > & 같은 글자가 있어도 태그로 해석되지 않고 글자 그대로 보이게 한다.
  // (바꿀 표는 매번 새로 만들지 않도록 함수 밖에 한 번만 만들어 둠)
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  // 날짜 형식기. 만드는 비용이 커서 한 번만 만들어 두고 계속 재사용한다.
  // 사용자의 컴퓨터 시간대와 상관없이 항상 한국 시간으로 표시.
  const timeFmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });

  // 밀리초 시간 → "2026. 10. 09. 오후 08:41:00" (코코포리아 내보내기와 같은 모양)
  function formatTime(ms) {
    // formatToParts는 [{type:"year", value:"2026"}, ...] 조각 배열을 준다 → { year: "2026", ... } 로 정리
    const p = {};
    for (const x of timeFmt.formatToParts(ms)) p[x.type] = x.value;
    // 12시간제 시각을 항상 두 자리로 (0시는 12로)
    const hour = String(Number(p.hour) % 12 || 12).padStart(2, "0");
    return `${p.year}. ${p.month}. ${p.day}. ${p.dayPeriod || ""} ${hour}:${p.minute}:${p.second}`;
  }

  // 캐릭터 이름 색. "#abc" / "#aabbcc" 같은 올바른 색 코드만 통과시키고,
  // 이상한 값이면 회색으로 (style 속성에 엉뚱한 문자열이 들어가는 것 방지)
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#888888");

  // 다운로드 버튼 아래 상태 문구 바꾸기 (isError면 빨간색)
  function setStatus(text, isError = false) {
    el.status.textContent = text;
    el.status.classList.toggle("is-error", isError);
  }

  // 드롭존의 글자와 상태(성공/오류) 표시를 바꾼다.
  // kind: "is-loaded" | "is-error" | 생략(기본 상태)
  function markDrop(drop, meta, mainText, metaText, kind) {
    drop.classList.remove("is-loaded", "is-error");
    if (kind) drop.classList.add(kind);
    drop.querySelector(".drop-main").textContent = mainText;
    meta.textContent = metaText;
  }


  // ── 파일 읽기 ────────────────────────────────────────────────────────

  // 01 스타일 HTML 읽기
  async function loadHtml(file) {
    state.baseAvatars = null;   // 아바타 대응표를 다시 계산하도록 캐시 비움
    try {
      // 문자열을 실제 HTML 문서로 해석 (화면에 붙이지 않으므로 스크립트도 실행되지 않음)
      const doc = new DOMParser().parseFromString(await file.text(), "text/html");
      const styles = [...doc.querySelectorAll("style")].map((s) => s.textContent);
      if (!styles.length) throw new Error("<style> 태그를 찾지 못했어요");

      state.css = styles.join("\n");
      const rawTitle = (doc.querySelector("h1")?.textContent || doc.title || "").trim();
      // "[서머] Heathcliff [메인]" → "Heathcliff"  (대괄호와 그 안의 글자 제거)
      // 다 지웠더니 빈 문자열이 되면 원래 제목을 그대로 쓴다
      state.htmlTitle = rawTitle.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() || rawTitle;

      // ── 아바타 정보 뽑기 ──
      // 원본 CSS에는 .avatar-image-0 { background-image: url(...) } 처럼 이미지가 클래스로 들어 있다.
      // 어떤 메시지가 어떤 클래스를 쓰는지 [시간, 클래스] 쌍으로만 기록해 둔다.
      // (파싱한 문서 전체를 계속 들고 있으면 메모리를 많이 차지하므로 필요한 것만 남기고 버림)
      const avatarClasses = new Set([...state.css.matchAll(/\.(avatar-image-\d+)\s*\{/g)].map((m) => m[1]));
      state.htmlAvatars = [];
      for (const art of doc.querySelectorAll("article")) {
        const av = art.querySelector(".avatar");
        const t = art.querySelector("time[datetime]");
        if (!av || !t) continue;
        const cls = [...av.classList].find((c) => avatarClasses.has(c));
        if (cls) state.htmlAvatars.push([Date.parse(t.getAttribute("datetime")), cls]);
      }

      // 제목칸이 비어 있을 때만 자동으로 채운다 (사용자가 입력한 제목은 덮어쓰지 않음)
      if (!el.title.value) el.title.value = state.htmlTitle;
      markDrop(el.dropHtml, el.metaHtml, file.name,
        `스타일 ${styles.length}개 · 아바타 ${avatarClasses.size}개`, "is-loaded");
    } catch (err) {
      state.css = ""; state.htmlAvatars = [];
      markDrop(el.dropHtml, el.metaHtml, file.name, `읽지 못했어요: ${err.message}`, "is-error");
    }
    render();
  }

  // 02 로그 JSON 읽기
  async function loadJson(file) {
    state.baseAvatars = null;   // 아바타 대응표를 다시 계산하도록 캐시 비움
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.messages)) throw new Error("messages 배열이 없어요");
      state.log = { messages: data.messages, images: data.images || {} };

      // 채널별 메시지 수 세기 (Map은 넣은 순서를 기억하므로 "처음 등장한 순서"가 유지됨)
      const map = new Map();
      for (const m of data.messages) {
        const id = m.channel ?? "";
        if (!map.has(id)) map.set(id, { id, name: m.channelName || id, count: 0 });
        map.get(id).count++;
      }
      // main을 맨 앞으로, 나머지는 등장 순서 그대로
      // (true - false = 1 이라서 main인 쪽이 앞으로 옴)
      state.channels = [...map.values()].sort((a, b) => (b.id === MAIN) - (a.id === MAIN));
      // 처음에는 main만 체크된 상태로 시작
      state.selected = new Set(map.has(MAIN) ? [MAIN] : []);

      renderChannels();
      markDrop(el.dropJson, el.metaJson, file.name,
        `메시지 ${data.messages.length.toLocaleString()}개 · 채널 ${state.channels.length}개`, "is-loaded");
    } catch (err) {
      state.log = null; state.channels = []; state.selected.clear();
      renderChannels();
      markDrop(el.dropJson, el.metaJson, file.name, `읽지 못했어요: ${err.message}`, "is-error");
    }
    render();
  }


  // ── 03 채널 목록 ─────────────────────────────────────────────────────

  // 채널 체크박스 목록을 다시 그린다.
  // 요소를 하나씩 만들어 붙이는 대신 HTML 문자열을 한 번에 넣어서 빠르다.
  function renderChannels() {
    const has = state.channels.length > 0;
    el.selAll.disabled = el.selNone.disabled = !has;
    if (!has) { el.channels.innerHTML = EMPTY_CHANNELS; return; }

    el.channels.innerHTML = state.channels.map((ch) => `
      <li class="channel">
        <label>
          <input type="checkbox" value="${esc(ch.id)}"${state.selected.has(ch.id) ? " checked" : ""} />
          <span class="channel-name">${esc(ch.name)}${ch.id !== ch.name ? `<span class="channel-id">${esc(ch.id)}</span>` : ""}</span>
          <span class="channel-count">${ch.count.toLocaleString()}</span>
        </label>
      </li>`).join("");
  }

  // 체크박스마다 이벤트를 달지 않고, 목록(<ul>) 하나에서 한꺼번에 처리한다 (이벤트 위임).
  // 목록을 다시 그려도 이벤트를 새로 달 필요가 없다.
  el.channels.addEventListener("change", (e) => {
    const box = e.target;
    if (box.type !== "checkbox") return;
    box.checked ? state.selected.add(box.value) : state.selected.delete(box.value);
    render();
  });

  // "전체" / "해제" 버튼
  function setAll(on) {
    state.selected = new Set(on ? state.channels.map((c) => c.id) : []);
    renderChannels();
    render();
  }


  // ── 아바타 (스탠딩 이미지) ───────────────────────────────────────────
  // JSON의 메시지에는 아이콘이 해시값(iconImage)으로만 들어 있고,
  // 원본 HTML에는 이미지가 .avatar-image-N 클래스로 들어 있다.
  // 두 파일에 같은 메시지가 같은 시간으로 기록돼 있으므로,
  // "시간"을 다리 삼아 [해시 → 원본 클래스] 대응표를 만든다.
  // 원본 클래스를 재사용하면 이미지를 결과 파일에 또 넣지 않아도 돼서 용량이 줄어든다.

  // 대응표는 HTML이나 JSON이 바뀔 때만 다시 만들고,
  // 채널·글꼴·제목을 바꿀 때는 저장해 둔 것을 재사용한다.
  function baseAvatars() {
    if (state.baseAvatars) return state.baseAvatars;
    // JSON: 시간 → 아이콘 해시
    const hashByTime = new Map();
    for (const m of state.log.messages) if (m.iconImage) hashByTime.set(m.createdAt, m.iconImage);
    // HTML의 [시간, 클래스]와 맞춰 보기
    const map = new Map();
    for (const [t, cls] of state.htmlAvatars) {
      const h = hashByTime.get(t);
      if (h && !map.has(h)) map.set(h, cls);
    }
    return (state.baseAvatars = map);
  }

  // 이번 결과에 들어갈 메시지들의 아바타 클래스를 정한다.
  // 원본 HTML에 없는 아이콘(예: 다른 탭에서만 쓰인 아이콘)은
  // JSON의 images에 들어 있는 이미지로 .avatar-json-N 클래스를 새로 만든다.
  function buildAvatars(messages) {
    // 저장해 둔 대응표를 복사해서 쓴다 (원본을 건드리면 다음 계산이 꼬이므로)
    const classByHash = new Map(baseAvatars());
    const extraCss = [];
    for (const m of messages) {
      const h = m.iconImage;
      if (!h || classByHash.has(h)) continue;
      const src = state.log.images[h];
      // 이미지 데이터(data:image/...)인 것만 사용
      if (typeof src !== "string" || !src.startsWith("data:image/")) continue;
      const cls = `avatar-json-${extraCss.length}`;
      classByHash.set(h, cls);
      // 큰따옴표가 섞여 있으면 url("...")이 깨지므로 %22로 바꿈
      extraCss.push(`.${cls}{background-image:url("${src.replace(/"/g, "%22")}")}`);
    }
    // 모든 avatar-json-N에 공통인 속성은 규칙 하나로 묶어서 한 번만 쓴다
    const shared = extraCss.length
      ? `[class*="avatar-json-"]{background-size:cover;background-position:center top}\n`
      : "";
    return { classByHash, extraCss: shared + extraCss.join("\n") };
  }


  // ── 결과 HTML 만들기 ─────────────────────────────────────────────────

  // 결과 파일에 덧붙이는 정렬 CSS.
  // main 이외 채널의 메시지에는 .side 클래스를 붙여서 오른쪽 정렬한다.
  //   - 일반 메시지: [본문][아바타] 순서로 칸을 바꾸고 글자를 오른쪽 정렬
  //   - 시스템 메시지: 왼쪽 들여쓰기를 없애고 오른쪽 정렬
  // .side 하나는 예전에 쓰던 :not([data-channel="main"])과 선택자 우선순위가 같아서
  // 원본 CSS와 겹칠 때 어느 쪽이 이기는지는 이전과 똑같다.
  // ⚠ 이 문자열은 결과 파일에 그대로 들어간다.
  const ALIGN_CSS = `
/* main 이외 채널: 우측 정렬 */
.message.side:not(.system) { grid-template-columns: minmax(0, 1fr) 40px; }
.message.side:not(.system) > :is(.avatar, .avatar-spacer) { grid-column: 2; grid-row: 1; }
.message.side:not(.system) > .message-content { grid-column: 1; grid-row: 1; text-align: right; }
.message.side:not(.system) .message-header { justify-content: flex-end; }
.message.side.system { padding-left: 0; text-align: right; }
.message.system .channel-name { display: block; margin-bottom: 4px; }`;

  // [채널 이름] 표시의 기본 모양.
  // :where()는 우선순위가 0이라서, 원본 CSS에 .channel-name 스타일이 있으면 그쪽이 항상 이긴다.
  const LABEL_BASE_CSS = `:where(.channel-name) { color: #888; font-size: 12px; }`;

  // 주사위 결과에 붙일 클래스 (원본 CSS가 성공/실패 색을 이 클래스로 칠함)
  function rollClass(r) {
    if (r.critical) return " critical";
    if (r.fumble) return " fumble";
    if (r.success) return " success";
    if (r.failure) return " failure";
    return "";
  }

  // 메시지 하나 → <article> HTML 문자열
  // 결과 파일 크기를 줄이려고 들여쓰기 공백 없이 출력한다.
  // ⚠ 머리글(.message-header) 안에서 요소 사이의 줄바꿈은 지우면 안 된다.
  //    화면에서 "이름 시간 [채널]" 사이의 띄어쓰기 한 칸으로 보이는 부분이라,
  //    지우면 글자가 서로 붙어 버린다.
  function renderMessage(m, classByHash) {
    const chId = m.channel ?? "";
    const system = m.type === "system";
    const cls = `message${system ? " system" : ""}${chId !== MAIN ? " side" : ""}`;
    const open = `<article class="${cls}" data-channel="${esc(chId)}">`;
    // main·info가 아니면 [채널 이름] 표시를 붙임
    const label = NO_LABEL.has(chId) ? "" : `<span class="channel-name">[${esc(m.channelName || chId)}]</span>\n`;
    const text = `<div class="message-text">${esc(m.text)}</div>`;

    // 시스템 메시지(주사위 안내 등)는 이름·시간·아바타 없이 본문만
    if (system) return `${open}\n${label}${text}\n</article>`;

    // 아바타가 있으면 이미지 칸, 없으면 같은 폭의 빈칸(avatar-spacer)으로 줄을 맞춤
    const av = m.iconImage && classByHash.get(m.iconImage);
    const avatar = av
      ? `<span class="avatar ${av}" aria-hidden="true"></span>`
      : `<span class="avatar-spacer" aria-hidden="true"></span>`;
    const edited = m.edited ? `<span class="edited">[편집 완료]</span>\n` : "";
    const roll = m.extend?.roll;
    const rollHtml = roll && roll.result ? `\n<span class="roll-result${rollClass(roll)}">${esc(roll.result)}</span>` : "";

    // 이름 색은 CSS 변수(--speaker-color)로 넘겨서 원본 CSS가 쓰게 한다
    return `${open}
${avatar}
<div class="message-content">
<div class="message-header">
<span class="speaker" style="--speaker-color:${safeColor(m.color)}">${esc(m.name)}</span>
<time class="timestamp" datetime="${new Date(m.createdAt).toISOString()}">${formatTime(m.createdAt)}</time>
${label}${edited}</div>
${text}${rollHtml}
</div>
</article>`;
  }

  // 결과 HTML 전체 만들기 → { html, count(메시지 수) }
  function buildOutput(title) {
    // 선택한 채널의 메시지만 골라 시간순으로 정렬
    // (filter가 새 배열을 만들기 때문에 sort가 원본 메시지 순서를 건드리지 않음)
    const messages = state.log.messages
      .filter((m) => state.selected.has(m.channel ?? ""))
      .sort((a, b) => a.createdAt - b.createdAt);
    const { classByHash, extraCss } = buildAvatars(messages);
    const body = messages.map((m) => renderMessage(m, classByHash)).join("\n\n");

    // 글꼴을 바꿨으면 @font-face와 함께 본문 글꼴·굵기를 덮어쓰는 CSS를 추가
    const f = currentFont();
    const fontCss = f ? `
/* 글꼴 */
${f.faces}
body, .message-list { font-family: '${f.family}', sans-serif; }
.message-list { font-weight: ${f.weight}; }` : "";

    // CSS 순서가 중요하다 (뒤에 올수록 같은 우선순위에서 이김):
    //   기본 라벨 → 원본 CSS → 정렬 → 글꼴 → 추가 아바타
    // 마지막 replace: CSS 안에 "</style"이라는 글자가 있으면 <style> 태그가 거기서 끝나 버리므로 막아 둔다.
    const css = `${LABEL_BASE_CSS}\n${state.css}\n${ALIGN_CSS}\n${fontCss}\n${extraCss}\n`.replace(/<\/style/gi, "<\\/style");

    const html = `<!DOCTYPE html>
<html lang="ko-KR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
<main class="message-list">
<h1 class="log-title">${esc(title)}</h1>

${body}

</main>
</body>
</html>
`;
    return { html, count: messages.length };
  }


  // ── 화면 갱신 ────────────────────────────────────────────────────────

  // 결과 다시 만들기 예약.
  // 제목을 타이핑할 때처럼 짧은 시간에 여러 번 불려도,
  // 마지막 호출 후 60ms 동안 조용해야 실제로 한 번만 만든다 (디바운스).
  let renderTimer = 0;
  function render() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(doRender, 60);
  }

  // 제목칸 → 원본 HTML 제목 → "log" 순서로, 처음 비어 있지 않은 것을 쓴다
  const currentTitle = () => el.title.value.trim() || state.htmlTitle || "log";

  // 실제로 결과를 만들고 미리보기·버튼·상태 문구를 갱신
  function doRender() {
    state.blob = null;
    const ready = state.css && state.log;

    // 파일이 아직 다 올라오지 않음 → 빈 화면 안내 + 무엇이 빠졌는지 표시
    if (!ready) {
      el.download.disabled = true;
      el.empty.hidden = false;
      el.count.textContent = "—";
      if (!state.css && !state.log) setStatus("파일 두 개를 올려 주세요.");
      else setStatus(state.css ? "로그 JSON을 올려 주세요." : "스타일 HTML을 올려 주세요.");
      return;
    }
    // 채널을 하나도 고르지 않음
    if (state.selected.size === 0) {
      el.download.disabled = true;
      el.count.textContent = "0개";
      setStatus("채널을 하나 이상 골라 주세요.", true);
      return;
    }

    const { html, count } = buildOutput(currentTitle());
    // 결과 HTML을 Blob(메모리 속 파일)으로 한 번만 만들어서
    // 미리보기, 용량 표시, 다운로드에 모두 같은 것을 쓴다.
    state.blob = new Blob([html], { type: "text/html" });

    // 이전 미리보기 주소는 해제해서 메모리를 돌려준다
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(state.blob);
    el.frame.src = state.previewUrl;
    el.empty.hidden = true;

    el.download.disabled = false;
    el.count.textContent = `${count.toLocaleString()}개`;
    // 1MB 이상이면 MB(소수 한 자리), 아니면 KB(정수)로 표시
    const kb = state.blob.size / 1024;
    setStatus(`메시지 ${count.toLocaleString()}개 · ${kb >= 1024 ? (kb / 1024).toFixed(1) + "MB" : Math.round(kb) + "KB"}`);
  }

  // 다운로드: 보이지 않는 <a download> 링크를 만들어 클릭시키는 방식
  function download() {
    if (!state.blob) return;
    // 파일 이름에 쓸 수 없는 문자(\ / : * ? " < > |)는 _로 바꾸고 너무 길면 자른다
    const name = currentTitle().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) + ".html";
    // 미리보기와 같은 주소를 쓰므로 새로 만들거나 해제할 필요가 없다
    // (다음에 결과가 바뀔 때 doRender에서 해제됨)
    const a = Object.assign(document.createElement("a"), { href: state.previewUrl, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }


  // ── 이벤트 연결 ──────────────────────────────────────────────────────

  // 드롭존 하나에 "파일 선택"과 "끌어다 놓기"를 함께 연결한다.
  // onFiles에는 항상 파일 배열이 넘어간다.
  function wireDrop(drop, input, onFiles) {
    input.addEventListener("change", () => {
      if (input.files.length) onFiles([...input.files]);
      // 값을 비워 두어야 같은 파일을 다시 골랐을 때도 change가 일어난다
      input.value = "";
    });
    // 파일을 끌고 들어오면 강조 표시. preventDefault를 해야 drop이 허용된다.
    ["dragenter", "dragover"].forEach((t) =>
      drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
    // 밖으로 나가거나 놓으면 강조 해제
    ["dragleave", "drop"].forEach((t) =>
      drop.addEventListener(t, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();   // 브라우저가 파일을 새 탭으로 여는 것을 막음
      if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    });
  }

  // HTML·JSON은 첫 번째 파일만, 글꼴은 여러 개를 한 번에 받는다
  wireDrop(el.dropHtml, el.fileHtml, (files) => loadHtml(files[0]));
  wireDrop(el.dropJson, el.fileJson, (files) => loadJson(files[0]));
  wireDrop(el.dropFont, el.fileFont, loadFonts);

  el.font.addEventListener("change", () => { state.font = el.font.value; render(); });
  el.selAll.addEventListener("click", () => setAll(true));
  el.selNone.addEventListener("click", () => setAll(false));
  el.title.addEventListener("input", render);
  el.download.addEventListener("click", download);

  // 처음 열었을 때 글꼴 선택칸 채우기
  renderFontSelect();

  // 드롭존 바깥에 파일을 떨어뜨렸을 때 브라우저가 그 파일을 열어 버려서
  // 작업 중인 화면이 사라지는 것을 막는다
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
})();
