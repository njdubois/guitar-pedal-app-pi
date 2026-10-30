let activeTab = "Amp", connected = false, schema = {}, ampDraft = {}, ampBase = {}, ampStored = {}, schemaProfile = "", editorDirty = false;
const pages = {};
let currentPedal = 0;
let ampView = "home", ampCategory = "Amp", ampGroup = "Amp", ampGroups = [];
const ampGroupNames = {Amp:"Amp",booster:"Booster",mod:"MOD",fx:"FX",delay:"Delay",delay2:"Delay 2",reverb:"Reverb",routing:"Routing & cabinet",solo:"Solo",contour:"Contour",pedalFx:"Pedal FX",eq1:"EQ 1",eq2:"EQ 2",noiseGate:"Noise suppressor",globalEq:"Global EQ",stageFeel:"Stage Feel",usbAudio:"USB audio"};
const $ = (selector) => document.querySelector(selector);
const clone = (value) => structuredClone(value);
let state = null, draft = null, revision = "", dirty = false, busy = false;
let pausePending = null, learningToken = null, importTarget = null, toastTimer;
let loopReceived = 0, lastLooperAction = null;
let polling = false, lastActivity = 0, portsKey = "", remoteConflict = false;
const loopNames = {
  record: "Record / replace selected track", record_new_track: "Record a new track", add_track: "Add empty track",
  finish_recording: "Finish recording", next_track: "Next track", scroll_tracks: "Scroll tracks (next, wraps to first)", previous_track: "Previous track",
  rename_track: "Rename selected track", duplicate_track: "Duplicate selected track", delete_track: "Delete selected track",
  play_stop: "Start / stop selected track", clear: "Clear selected track", overdub: "Overdub selected track",
  undo: "Undo selected overdub", redo: "Redo selected overdub", mute: "Mute / unmute selected track",
  volume_up: "Selected track volume +10%", volume_down: "Selected track volume −10%",
  pause: "Pause / resume selected track", reverse: "Reverse selected track", oneshot: "Play selected track once",
  trigger: "Restart selected track", play_all: "Play all tracks", stop_all: "Stop all tracks", clear_all: "Clear all tracks",

};

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "on") for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (key === "value") node.value = value;
    else if (key === "disabled") node.disabled = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}
function option(value, label) { return element("option", {value, text: label}); }
function label(title, control) { return element("label", {}, [element("span", {text: title}), control]); }
function button(title, handler, className = "button secondary") {
  return element("button", {type: "button", class: className, text: title, on: {click: () => run(handler)}});
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.toggle("error-toast", error);
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, error ? 10000 : 4500);
}
async function run(handler) {
  try { await handler(); } catch (error) { toast(error.message, true); }
}
async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: {"Content-Type": "application/json", "X-Pedal-Token": state?.token || ""},
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The controller could not complete that action.");
  return result;
}
function setBusy(value) { busy = value; updateStatus(); }
function pauseForEditing() {
  if (state?.running && !pausePending) {
    pausePending = api("/api/pause", {}).then(() => {
      state.running = false;
    }).catch((error) => {
      toast("Could not stop the pedals: " + error.message, true);
      throw error;
    }).finally(() => { pausePending = null; updateStatus(); });
    // The promise is also awaited before saving, learning, or starting.
    pausePending.catch(() => {});
  }
}
function changed(redraw = false) {
  dirty = true;
  pauseForEditing();
  updateStatus();
  if (redraw) renderCards();
}
function findSwitch(id) { return draft.switches.find((item) => item.id === id); }
function groupFor(pedal, position) {
  return position ? pedal.position_actions[position] : pedal.actions;
}
function setGroup(pedal, position, actions) {
  if (position) {
    pedal.position_actions[position] = actions;
    if (position === "open") pedal.actions = clone(actions);
  } else pedal.actions = actions;
}
function setFirstAction(pedal, position, action) {
  const actions = groupFor(pedal, position);
  setGroup(pedal, position, [action, ...actions.slice(1)]);
  changed(true);
}
function unassigned() { return {type: "event", name: "pedal.unassigned"}; }

function actionEditor(pedal, position = null) {
  const actions = groupFor(pedal, position);
  const action = actions[0] || unassigned();
  const kind = ["tone", "looper", "channel"].includes(action.type) ? action.type : "none";
  const editor = element("div", {class: "action-editor"});
  editor.append(element("div", {class: "position-label", text: position === "open" ? "Position A" : position === "closed" ? "Position B" : "On every click"}));
  const typeSelect = element("select", {"aria-label": "Action type for " + pedal.name + (position ? " position " + position : "")});
  typeSelect.append(option("tone", "Load tone"), ...(draft.amp.profile === "go2" ? [option("channel", "GO:2 channel")] : []), option("looper", "Looper"), option("none", "No action"));
  typeSelect.value = kind;
  typeSelect.addEventListener("change", () => {
    const first = typeSelect.value === "tone" ? {type: "tone", file: ""} :
      typeSelect.value === "channel" ? {type:"channel",bank:1,channel:"A"} :
      typeSelect.value === "looper" ? {type: "looper", command: "record"} : unassigned();
    setFirstAction(pedal, position, first);
  });
  const row = element("div", {class: "action-row"}, [typeSelect]);
  if (kind === "tone") {
    const select = element("select", {"aria-label": "Tone for " + pedal.name + (position ? " position " + position : "")});
    select.append(option("", "Choose a tone…"));
    const tones = state.library.filter((item) => item.profile === draft.amp.profile);
    for (const item of tones) select.append(option(item.file, item.name));
    if (action.file && !tones.some((item) => item.file === action.file)) {
      const unavailable = option(action.file, "Choose a tone for this amp");
      unavailable.disabled = true;
      select.append(unavailable);
    }
    select.value = action.file || "";
    select.addEventListener("change", () => setFirstAction(pedal, position, {type: "tone", file: select.value}));
    row.append(select);
  } else if (kind === "channel") {
    const bank=element("select",{"aria-label":"Bank for " + pedal.name});
    for(let n=1;n<=10;n++) bank.append(option(String(n),"Bank " + n));
    bank.value=String(action.bank);
    const channel=element("select",{"aria-label":"Channel for " + pedal.name});
    for(const c of "ABC") channel.append(option(c,c));
    channel.value=action.channel;
    const update=()=>setFirstAction(pedal,position,{type:"channel",bank:Number(bank.value),channel:channel.value});
    bank.addEventListener("change",update);channel.addEventListener("change",update);row.append(bank,channel);
  } else if (kind === "looper") {
    const select = element("select", {"aria-label": "Looper command for " + pedal.name});
    for (const [command, title] of Object.entries(loopNames)) select.append(option(command, title));
    select.value = action.command;
    select.addEventListener("change", () => setFirstAction(pedal, position, {type: "looper", command: select.value, ...(select.value === "rename_track" ? {name:"My track"} : {})}));
    row.append(select);
    if(action.command === "rename_track") {
      const name=element("input",{type:"text",value:action.name || "",maxlength:"60","aria-label":"New track name for " + pedal.name});
      name.addEventListener("input",()=>{action.name=name.value;changed();});
      editor.append(label("Track name",name));
    }
  } else {
    row.append(element("p", {class: "empty-action", text: action.name === "pedal.unassigned" ? "No sound change." : "Custom event: " + action.name}));
  }
  editor.append(row);
  editor.append(button("Choose / import JSON", () => openLibrary({slot: pedal.id, position}), "text-button import-link"));
  if (actions.length > 1) editor.append(element("p", {class: "extra-actions", text: "Also keeps " + (actions.length - 1) + " additional configured action(s)."}));
  return editor;
}

function renderCards() {
  if (!draft) return;
  currentPedal = Math.min(currentPedal, Math.max(0, draft.switches.length - 1));
  const cards = [];
  for (const [index, pedal] of draft.switches.entries()) {
    const card = element("article", {class: "pedal-card", "data-pedal": pedal.id});
    const position = element("span", {class: "position", "data-position": pedal.id, text: "Waiting…"});
    const previous = button("← Previous", () => showPedal(currentPedal - 1));
    const next = button("Next →", () => showPedal(currentPedal + 1));
    previous.disabled = index === 0;
    next.disabled = index === draft.switches.length - 1;
    card.append(element("div", {class: "pedal-head"}, [
      previous,
      element("span", {class: "pedal-number", text: "Pedal " + (index + 1) + " of " + draft.switches.length, "aria-live": "polite"}),
      position, next,
    ]));
    card.hidden = index !== currentPedal;
    const body = element("div", {class: "pedal-body"});
    const nameInput = element("input", {type: "text", class: "name-input", value: pedal.name || "Pedal " + (index + 1), maxlength: "80", "aria-label": "Pedal " + (index + 1) + " name"});
    nameInput.addEventListener("input", () => { pedal.name = nameInput.value; changed(); });
    body.append(label("Pedal name", nameInput));
    const pin = state.gpio.pins.find((item) => item.gpio === pedal.gpio);
    const info = element("div", {class: "pin-info"});
    if (pin) {
      info.append(element("strong", {text: "Identified"}), element("br"), document.createTextNode("Ready"));
    } else info.append(element("span", {class: "not-identified", text: "Not identified yet"}));
    const connectionRow = element("div", {class: "connection-row"}, [
      info, button("Identify pedal", () => identify(pedal.id), "button secondary identify-button"),
    ]);
    const mode = element("select", {class: "mode-select", "aria-label": "Trigger behavior for " + pedal.name});
    mode.append(option("same", "Same action on every click"), option("positions", "Different actions for A / B"));
    mode.value = pedal.position_actions ? "positions" : "same";
    mode.addEventListener("change", () => {
      if (mode.value === "positions") pedal.position_actions = {open: clone(pedal.actions), closed: clone(pedal.actions)};
      else { pedal.actions = clone(pedal.position_actions.open); delete pedal.position_actions; }
      changed(true);
    });
    const behavior = label("Switch behavior", mode);
    body.append(behavior);
    card.classList.toggle("split-actions", !!pedal.position_actions);
    if (pedal.position_actions) {
      body.append(actionEditor(pedal, "open"), actionEditor(pedal, "closed"));
    } else body.append(actionEditor(pedal));
    body.append(connectionRow);
    card.append(body);
    cards.push(card);
  }
  $("#pedals").replaceChildren(...cards);
  updateLive();
}

function showPedal(index) {
  currentPedal = Math.max(0, Math.min(index, draft.switches.length - 1));
  for (const [position, card] of [...$("#pedals").children].entries()) {
    card.hidden = position !== currentPedal;
  }
}

function updateStatus() {
  if (!state || !draft) return;
  const ampWaiting = busy || state.amp_busy;
  $("#amp-controls").inert = ampWaiting;
  for (const id of ["amp-back", "amp-previous", "amp-next"]) $("#" + id).disabled = ampWaiting || $("#" + id).dataset.boundary === "true";
  $("#amp-card-menu").inert = ampWaiting;
  $("#delay-slots").inert = ampWaiting;
  for (const id of ["read-amp", "apply-amp", "capture-tone"]) $("#" + id).disabled = ampWaiting;
  $("#save-status").textContent = dirty ? "Unsaved changes" : "Setup saved";
  $("#save-status").classList.toggle("unsaved", dirty);
  $("#save").disabled = !dirty || busy || !!pausePending || remoteConflict;
  const running = state.running;
  $("#start").textContent = busy ? "Please wait…" : state.stopping || pausePending ? "Stopping…" : running ? "Stop pedals" : $("#test-mode").checked || state.demo ? "Start test" : "Start pedals";
  $("#start").disabled = busy || !!pausePending || state.stopping || state.amp_busy || !!state.learning || remoteConflict || state.gpio.status !== "ready";
  $("#run-status").textContent = state.stopping || pausePending ? "Stopping" : state.learning ? "Identifying" : running ? (state.dry_run ? "Test mode" : "Running") : "Stopped";
  $("#run-status").className = "status" + (running ? state.dry_run ? " testing" : " running" : "");
  $("#pedal-count").disabled = busy;
  $("#amp-profile").disabled = busy;
  $("#test-mode").disabled = busy || state.demo;
  $("#check-amp").disabled = busy || state.amp_busy;
  $("#refresh-ports").disabled = busy || state.amp_busy;
  $("#check-amp").textContent = state.amp_busy ? "Connecting…" : "Connect";
  $("#library-count").textContent = state.library.filter((item) => item.profile === draft.amp.profile).length;
}

function updateLive() {
  if (!state || !draft) return;
  for (const pedal of draft.switches) {
    const card = [...$("#pedals").children].find((item) => item.dataset.pedal === pedal.id);
    if (!card) continue;
    const value = state.levels[pedal.gpio];
    card.querySelector(".position").textContent = pedal.gpio == null ? "Unassigned" : value === undefined ? "Waiting…" : value ? "Position B" : "Position A";
    const hit = state.last_hits[pedal.id];
    if (hit && card.dataset.hit !== String(hit)) {
      card.dataset.hit = String(hit);
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 650);
    }
    const identifyButton = card.querySelector(".identify-button");
    identifyButton.disabled = busy || state.gpio.status !== "ready";
    identifyButton.textContent = state.learning?.slot === pedal.id ? "Listening…" : "Identify pedal";
  }
  const learning = state.learning;
  $("#learning-panel").hidden = !learning;
  if (learning) {
    const pedal = findSwitch(learning.slot);
    $("#learning-title").textContent = "Click " + (pedal?.name || "this pedal") + " " + (learning.changes ? "once more" : "twice");
    $("#learning-detail").textContent = learning.changes ? "First click detected. Click the same pedal again to confirm. " + (learning.remaining ?? 25) + "s remaining." : "Press until it clicks, release, then click again. Other pedal actions are paused.";
  }
  $("#input-error").hidden = state.gpio.status !== "error";
  $("#input-error-text").textContent = "Pedal inputs unavailable. See Logs for details.";
  const loop = state.looper;
  loopReceived = performance.now();
  $("#looper-status").textContent = loop?.error ? "Looper: " + loop.error :
    loop?.notice ? loop.notice : loop?.active ? `${loop.tracks?.length || 1} tracks · ${loop.output_clipping ? "Mix clipping · lower track volumes" : loop.clipping ? "Input clipping" : "Ready"}` :
    "Start looper to record. Select a track to edit it.";
  $("#looper-status").classList.toggle("error-text", !!loop?.error || !!loop?.notice);
  renderLoopTracks();
  $("#loop-mode").textContent = loop?.active ? loop.mode : "Stopped";
  $("#loop-mode").dataset.mode = loop?.active ? loop.mode : "stopped";
  $("#loop-timing").textContent = loop?.active ?
    `Audio block ${loop.block_ms} ms · playback buffer ${loop.buffer_ms} ms · audio recoveries ${loop.xruns}.` : "";
  $("#amp-status").textContent = state.amp.message;
  $("#amp-status").classList.toggle("error-text", state.amp.status === "error");
  if (state.amp.profile && state.amp.profile !== draft.amp.profile && state.amp.status === "connected") {
    $("#amp-status").textContent = "Amp model changed. Click Check amp to check this model.";
  }
  const key = JSON.stringify(state.amp.ports);
  if (key !== portsKey) { portsKey = key; renderPorts(); }
  const newest = state.events.at(-1)?.id || 0;
  if (newest !== lastActivity) {
    lastActivity = newest;
    $("#activity").replaceChildren(...state.events.slice(-80).reverse().map((event) =>
      element("li", {class: event.kind === "error" ? "error-text" : ""}, [
        element("time", {text: event.time}), element("span", {text: event.message}),
      ])));
    $("#activity-status").textContent = state.events.at(-1)?.time || "";
  }
  updateStatus();
}

function renderPorts() {
  for (const direction of ["input", "output"]) {
    const select = $("#midi-" + direction);
    const selected = draft.amp[direction] || "";
    const ports = state.amp.ports?.[direction + "s"] || [];
    select.replaceChildren(option("", "Automatic"));
    for (const port of ports) select.append(option(port.name, port.name));
    if (selected && !ports.some((port) => port.name === selected)) select.append(option(selected, selected));
    select.value = selected;
  }
}
function renderDemo() {
  $("#demo-banner").hidden = !state.demo;
  $("#demo-controls").hidden = !state.demo;
  if (!state.demo) return;
  $("#test-mode").checked = true;
  $("#demo-buttons").replaceChildren(...state.gpio.pins.slice(0, Math.max(draft.switches.length, 3)).map((pin, index) =>
    button("Click pedal " + (index + 1), async () => { await api("/api/demo/toggle", {gpio: pin.gpio}); await poll(); })));
}

async function identify(id) {
  if (pausePending) await pausePending;
  setBusy(true);
  try {
    const result = await api("/api/learn", {slot: id});
    learningToken = result.token;
    await poll();
  } finally { setBusy(false); updateLive(); }
}
function applyIdentification(result) {
  const pedal = findSwitch(result.slot);
  if (!pedal) return;
  const previous = pedal.gpio;
  const other = draft.switches.find((item) => item.id !== pedal.id && item.gpio === result.gpio);
  if (other) other.gpio = previous;
  pedal.gpio = result.gpio;
  learningToken = null;
  dirty = true;
  renderCards();
  toast(other ? "Identified. Swapped the connection with " + other.name + "." : pedal.name + " identified. Save your setup when ready.");
}
function validateDraft() {
  const unlearned = draft.switches.find((pedal) => pedal.gpio == null);
  if (unlearned) throw new Error("Click Identify pedal for " + unlearned.name + " before saving.");
  for (const pedal of draft.switches) {
    const groups = [pedal.actions, ...Object.values(pedal.position_actions || {})];
    for (const action of groups.flat()) if (action.type === "tone") {
      if (!action.file) throw new Error("Choose a tone for " + pedal.name + ".");
      const tone = state.library.find((item) => item.file === action.file);
      if (!tone || tone.profile !== draft.amp.profile) throw new Error("Choose a tone that matches the selected amp for " + pedal.name + ".");
    }
  }
}
async function saveSetup() {
  validateDraft();
  if (pausePending) await pausePending;
  setBusy(true);
  try {
    const result = await api("/api/setup", {config: draft, revision});
    draft = clone(result.config);
    revision = result.revision;
    dirty = false;
    learningToken = null;
    renderCards();
    toast("Setup saved on the Pi.");
  } finally { setBusy(false); }
}
async function toggleRun() {
  if (state.running) {
    setBusy(true);
    try { await api("/api/pause", {}); await poll(); }
    finally { setBusy(false); }
    return;
  }
  if (dirty) await saveSetup();
  setBusy(true);
  try {
    await api("/api/start", {revision, dry_run: $("#test-mode").checked});
    await poll();
    toast(state.demo || $("#test-mode").checked ? "Test mode started. Click a pedal to see its action." : "Pedals started. Your tone assignments are live.");
  } finally { setBusy(false); }
}

function openLibrary(target = null) {
  importTarget = target;
  $("#library-message").textContent = target ? "Choose a tone to assign to " + findSwitch(target.slot).name + "." : "";
  $("#library-message").classList.remove("error-text");
  renderLibrary();
  selectTab("Tones");
}
function assignTone(file) {
  if (!importTarget) return;
  const target = importTarget;
  const pedal = findSwitch(target.slot);
  if (pedal) {
    setFirstAction(pedal, target.position, {type: "tone", file});
    toast("Tone assigned. Save your setup when ready.");
  }
  selectTab("Pedals");
  importTarget = null;
}
function renderLibrary() {
  const tones = state.library.filter((item) => item.profile === draft.amp.profile);
  const nodes = tones.map((tone) => {
    const actions = element("div", {class: "library-actions"}, [
      button("Load", () => loadLibraryTone(tone), "button secondary"),
      button("Export", () => exportTone(tone), "text-button"),
      button("JSON", () => viewTone(tone), "text-button"),
    ]);
    if (importTarget) actions.append(button("Assign", () => assignTone(tone.file), "button secondary"));
    return element("article", {class: "library-item"}, [
      element("div", {}, [element("h3", {text: tone.name}), element("p", {text: tone.summary || "Local tone JSON"})]), actions,
    ]);
  });
  if (!nodes.length) nodes.push(element("p", {class: "muted", text: "No tones for this amp yet. Import a JSON file or paste one below."}));
  $("#library-list").replaceChildren(...nodes);
}
function openJson(name = "", document = null) {
  $("#json-heading").textContent = document ? "Save a copy of this tone" : "Paste a tone";
  $("#tone-name").value = name;
  $("#tone-json").value = document ? JSON.stringify(document, null, 2) : "";
  $("#json-error").textContent = "";
  $("#json-dialog").showModal();
  $("#tone-name").focus();
}
async function viewTone(tone) {
  const document = await api("/api/tone?file=" + encodeURIComponent(tone.file));
  openJson(tone.name + " copy", document);
}
async function importFiles(files) {
  let imported = [];
  $("#library-message").textContent = "Validating tone files…";
  $("#library-message").classList.remove("error-text");
  for (const file of files) {
    try {
      if (file.size > 1024 * 1024) throw new Error("File is larger than 1 MB.");
      const document = JSON.parse(await file.text());
      const result = await api("/api/tones", {name: file.name.replace(/\.json$/i, "").replace(/[_-]/g, " "), document, profile: draft.amp.profile});
      state.library = result.library;
      imported.push(result.file);
    } catch (error) {
      $("#library-message").textContent = file.name + ": " + error.message;
      $("#library-message").classList.add("error-text");
      renderLibrary(); renderCards(); updateStatus();
      return;
    }
  }
  renderLibrary(); renderCards(); updateStatus();
  $("#library-message").textContent = imported.length + " tone file(s) imported.";
  if (imported.length === 1 && importTarget) assignTone(imported[0]);
}
async function saveTone() {
  $("#json-error").textContent = "";
  $("#save-tone").disabled = true;
  try {
    let document;
    try { document = JSON.parse($("#tone-json").value); }
    catch { throw new Error("The JSON could not be read. Paste the complete object, including its opening and closing braces."); }
    const result = await api("/api/tones", {name: $("#tone-name").value, document, profile: draft.amp.profile});
    state.library = result.library;
    renderLibrary(); renderCards(); updateStatus();
    $("#json-dialog").close();
    if (importTarget) assignTone(result.file);
    else toast("Tone validated and saved to your library.");
  } catch (error) { $("#json-error").textContent = error.message; }
  finally { $("#save-tone").disabled = false; }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await api("/api/state");
    state = next;
    if (!draft) {
      draft = clone(state.config);
      revision = state.revision;
      $("#pedal-count").value = draft.switches.length;
      $("#amp-profile").value = draft.amp.profile;
      renderCards(); renderPorts(); renderDemo();
    } else if (state.revision !== revision && !busy) {
      if (dirty) {
        remoteConflict = true;
        $("#connection-error").textContent = "The saved setup changed in another window. Reload this page to load it; your unsaved edits are still shown.";
        $("#connection-error").hidden = false;
      } else {
        draft = clone(state.config);
        revision = state.revision;
        $("#pedal-count").value = draft.switches.length;
        $("#amp-profile").value = draft.amp.profile;
        renderCards(); renderPorts(); renderDemo();
      }
    }
    if (!remoteConflict) $("#connection-error").hidden = true;
    if (learningToken && state.identification?.token === learningToken) applyIdentification(state.identification);
    updateLive();
    await updateConnection();
    const action = state.looper_action_id ?? 0;
    if (lastLooperAction !== null && action > lastLooperAction) selectTab("Loops");
    lastLooperAction = action;
  } catch (error) {
    $("#connection-error").textContent = "Controller disconnected. Keep the Python interface running on the Pi. Reconnecting…";
    $("#connection-error").hidden = false;
    $("#start").disabled = true;
    showConnection();
  } finally { polling = false; }
}

for (let count = 1; count <= 10; count++) $("#pedal-count").append(option(String(count), String(count)));
$("#pedal-count").addEventListener("change", () => {
  const count = Number($("#pedal-count").value);
  while (draft.switches.length < count) {
    const ids = new Set(draft.switches.map((item) => item.id));
    let id = 1;
    while (ids.has(String(id))) id++;
    draft.switches.push({id: String(id), name: "Pedal " + (draft.switches.length + 1), gpio: null, actions: [unassigned()]});
  }
  draft.switches = draft.switches.slice(0, count);
  changed(true); renderDemo();
});
$("#amp-profile").addEventListener("change", () => {
  draft.amp.profile = $("#amp-profile").value;
  draft.amp.input = null; draft.amp.output = null;
  changed(true); renderPorts(); updateLive();
});
for (const direction of ["input", "output"]) $("#midi-" + direction).addEventListener("change", (event) => {
  draft.amp[direction] = event.target.value || null; changed();
});
$("#test-mode").addEventListener("change", () => { pauseForEditing(); updateStatus(); });
$("#save").addEventListener("click", () => run(saveSetup));
$("#start").addEventListener("click", () => run(toggleRun));
$("#cancel-learning").addEventListener("click", () => run(async () => {
  await api("/api/learn/cancel", {}); learningToken = null; await poll();
}));
$("#retry-inputs").addEventListener("click", () => run(async () => { await api("/api/hardware/retry", {}); await poll(); }));
$("#check-amp").addEventListener("click", () => run(async () => {
  if (pausePending) await pausePending;
  await api("/api/amp/check", draft.amp); await poll();
}));
$("#refresh-ports").addEventListener("click", () => run(async () => {
  if (pausePending) await pausePending;
  await api("/api/amp/ports", draft.amp); await poll();
}));
$("#open-library").addEventListener("click", () => openLibrary());
$("#paste-tone").addEventListener("click", () => openJson());
$("#choose-files").addEventListener("click", () => $("#tone-files").click());
$("#tone-files").addEventListener("change", (event) => {
  const files = [...event.target.files]; event.target.value = "";
  run(() => importFiles(files));
});
$("#refresh-library").addEventListener("click", () => run(async () => {
  await api("/api/library/refresh", {}); await poll(); renderLibrary(); renderCards();
}));
$("#save-tone").addEventListener("click", saveTone);
$("#cancel-json").addEventListener("click", () => $("#json-dialog").close());
document.querySelectorAll(".close-dialog").forEach((node) => node.addEventListener("click", () => node.closest("dialog").close()));

$("#download-setup").addEventListener("click", () => run(() => {
  validateDraft();
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2) + "\n"], {type: "application/json"}));
  const link = element("a", {href: url, download: "pedals.json"}); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
window.addEventListener("beforeunload", (event) => {
  if (dirty || editorDirty) { event.preventDefault(); event.returnValue = ""; }
});
initializeTabs();
await poll();
setInterval(poll, 250);
function animateLooper() {
  const loop = state?.looper;
  if (loop && activeTab === "Loops") {
    const elapsed = loop.active && !loop.error && performance.now() - loopReceived < 500 ? (performance.now() - loopReceived) / 1000 : 0;
    for (const track of loop.tracks || []) {
      const row=$("#loop-tracks [data-track='" + track.id + "']");
      if(!row)continue;
      const moving=loop.active && ["playing","overdubbing"].includes(track.mode);
      const position=moving && track.seconds ? (track.position + (track.reverse ? -1 : 1) * elapsed / track.seconds + 1) % 1 : track.position;
      row.querySelector("progress").value=position || 0;
      const canvas=row.querySelector("canvas"),ctx=canvas.getContext("2d");
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle=["recording","overdubbing"].includes(track.mode) ? "#b83e50" : track.muted ? "#9ba59c" : "#398967";
      for(const [index,value] of (track.waveform || []).entries()) {
        const height=Math.min(1,value*4)*canvas.height;
        ctx.fillRect(index*canvas.width/64,(canvas.height-height)/2,canvas.width/64-1,Math.max(1,height));
      }
    }
  }
  requestAnimationFrame(animateLooper);
}
requestAnimationFrame(animateLooper);



async function loopCommand(command, options={}) {
  await api("/api/looper",{command,...options});
  selectTab("Loops");
  await poll();
}
function selectedLoopTrack() {return state?.looper?.tracks?.find(track=>track.id===state.looper.selected_track);}
function renderLoopTracks() {
  const loop=state?.looper;
  if(!loop)return;
  const tracks=loop.tracks || [], selected=selectedLoopTrack();
  $("#looper-audio").textContent=loop.active ? "Stop looper" : "Start looper";
  $("#looper-record").textContent=selected?.mode === "recording" ? "Finish take" : "Record / replace";
  $("#looper-mute").textContent=selected?.muted ? "Unmute" : "Mute";
  $("#looper-selected").textContent=selected ? selected.name : "No track";
  const list=$("#loop-tracks");
  const key=tracks.map(track=>track.id).join(",");
  if(list.dataset.tracks!==key) {
    list.dataset.tracks=key;
    list.replaceChildren(...tracks.map(track=>{
      const pick=button("",()=>loopCommand("select_track",{track_id:track.id}),"track-select");
      pick.append(element("strong",{class:"track-name"}),element("span",{class:"track-info"}));
      const canvas=element("canvas",{width:"640",height:"22","aria-label":"Recorded input level history"});
      const progress=element("progress",{max:"1",value:0,"aria-label":"Track position"});
      return element("article",{class:"loop-track","data-track":track.id},[pick,canvas,progress]);
    }));
  }
  const old=list.dataset.selected;
  for(const track of tracks) {
    const row=$("#loop-tracks [data-track='" + track.id + "']");
    row.classList.toggle("selected-track",track.selected);
    row.querySelector("button").setAttribute("aria-pressed",String(track.selected));
    row.querySelector(".track-name").textContent=track.name;
    row.querySelector(".track-info").textContent=`${track.mode} · ${track.seconds}s · ${track.muted ? "Muted" : "Volume " + track.volume + "%"}${track.reverse ? " · Reverse" : ""}`;
  }
  list.dataset.selected=String(loop.selected_track);
  if(old!==list.dataset.selected && activeTab === "Loops") $("#loop-tracks .selected-track")?.scrollIntoView({block:"nearest"});
}
function initializeLooper() {
  const selected=()=>({track_id:selectedLoopTrack()?.id});
  $("#looper-audio").addEventListener("click",()=>run(()=>loopCommand(state.looper.active ? "stop_audio" : "start_audio")));
  for(const [id,command] of Object.entries({"looper-add":"add_track","looper-new-record":"record_new_track","looper-play-all":"play_all","looper-stop-all":"stop_all","looper-prev":"previous_track","looper-next":"next_track"})) {
    $("#"+id).addEventListener("click",()=>run(()=>loopCommand(command)));
  }
  for(const [id,command] of Object.entries({"looper-record":"record","looper-mute":"mute","looper-clear":"clear","looper-delete":"delete_track","looper-copy":"duplicate_track","looper-play":"play_stop"})) {
    $("#"+id).addEventListener("click",()=>run(()=>loopCommand(command,selected())));
  }
  $("#looper-rename").addEventListener("click",()=>run(async()=>{
    const track=selectedLoopTrack();if(!track)return;
    const name=prompt("Track name",track.name);if(name===null)return;
    await loopCommand("rename_track",{track_id:track.id,name});
  }));
  for(const [id,command] of [["looper-quieter","volume_down"],["looper-louder","volume_up"]]) $("#"+id).addEventListener("click",()=>run(()=>loopCommand(command,selected())));
}
function initializeTabs() {
  const main = $("main");
  const connection = $(".connection-panel");
  connection.id = "connect-page";
  connection.prepend(element("h1", {text: "Connect your amp"}));
  connection.prepend($("#amp-profile").parentElement);
  main.prepend(connection);
  for (const name of ["Amp", "Tones", "Pedals", "Loops", "Logs"]) {
    const page = element("section", {id: "page-" + name.toLowerCase(), role: "tabpanel", "aria-labelledby": "tab-" + name, hidden: ""});
    pages[name] = page; main.append(page);
    const tab = button(name, () => selectTab(name), "tab");
    tab.id = "tab-" + name; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", page.id);
    $("#tabs").append(tab);
    tab.addEventListener("keydown", event => {
      const names = Object.keys(pages), index = names.indexOf(name);
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? 4 : (index + (event.key === "ArrowRight" ? 1 : 4)) % 5;
        selectTab(names[next]); $("#tab-" + names[next]).focus();
      }
    });
  }
  pages.Amp.append($("#amp-editor")); $("#amp-editor").hidden = false;
  pages.Tones.append($("#library-dialog")); $("#library-dialog").hidden = false;
  for (const selector of [".setup-bar", "#learning-panel", "#input-error", "#demo-controls", "#pedals"]) pages.Pedals.append($(selector));
  pages.Loops.append($(".looper-panel"));
  pages.Logs.append($(".activity-panel"), $("#loop-timing"), $("footer"));
  $(".activity-heading").append(button("Download logs", () => {
    const url = URL.createObjectURL(new Blob([state.events.map(event => `${event.time} [${event.kind}] ${event.message}`).join("\n") + "\n"], {type: "text/plain"}));
    element("a", {href: url, download: "katana-logs.txt"}).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  $(".intro").hidden = true;
  $("#demo-banner").remove();
  // Keep the demo indicator compact in the persistent header.
  const demo = element("span", {id: "demo-banner", class: "small", text: "Demo", hidden: ""}); $(".top-actions").prepend(demo);
  $(".brand").textContent = "KATANA";
  $("#check-amp").textContent = "Connect";
  
  $("#amp-back").addEventListener("click", () => {
    ampView = ampView === "controls" && ampCategory === "Effects" ? "effects" : "home";
    renderAmp();
  });
  $("#amp-previous").addEventListener("click", () => moveAmpCard(-1));
  $("#amp-next").addEventListener("click", () => moveAmpCard(1));
  $("#read-amp").addEventListener("click", () => run(async () => {
    if (editorDirty && !confirm("Discard unapplied amp changes and read the amp?")) return;
    editorDirty = false; await api("/api/amp/check", state.amp.options || draft.amp); await poll();
  }));
  $("#apply-amp").addEventListener("click", () => run(applyAmp));
  $("#capture-tone").addEventListener("click", () => run(async () => {
    if (editorDirty) throw new Error("Apply your changes before saving the live tone.");
    const name = prompt("Tone name", "My tone"); if (!name) return;
    setBusy(true);
    try {
      const result = await api("/api/amp/capture", {name});
      state.library = result.library; renderLibrary(); toast("Tone saved to your library.");
    } finally { setBusy(false); }
  }));
  const memories=element("dialog",{id:"amp-memories"});
  const bank=element("select",{"aria-label":"Memory bank"}), channel=element("select",{"aria-label":"Memory channel"});
  for(let n=1;n<=10;n++)bank.append(option(String(n),"Bank " + n));
  for(const c of "ABC")channel.append(option(c,c));
  const target=element("p",{class:"small muted"});
  const write=button("Write current tone",()=>memoryAction("write-memory"),"button primary");
  const update=()=>{write.textContent=`Write to ${bank.value}${channel.value}`;target.textContent=`Write replaces the saved tone in Bank ${bank.value} / ${channel.value}. A backup is saved locally first. Recall replaces the live tone.`;};
  bank.addEventListener("change",update);channel.addEventListener("change",update);update();
  const memoryAction=async(command)=>run(async()=>{
    if(busy)return;
    if(editorDirty)throw new Error("Apply your amp changes before using onboard memories.");
    setBusy(true);
    try {
      const result=await api("/api/amp/memory",{command,bank:Number(bank.value),channel:channel.value});
      memories.close();await poll();
      toast(command==="write-memory" ? (state.demo ? "Demo: channel write simulated." : `Tone written to ${bank.value}${channel.value}.`) : `Recalled ${bank.value}${channel.value}.`);
    } finally {setBusy(false);}
  });
  memories.append(element("h2",{text:"GO:2 onboard memories"}),element("div",{class:"action-row"},[bank,channel]),target,
    element("div",{class:"action-row"},[button("Recall",()=>memoryAction("recall-memory"),"button secondary"),write,button("Close",()=>memories.close(),"button secondary")]));
  document.body.append(memories);
  $("#amp-memories-open").addEventListener("click",()=>{if(state.amp.profile!=="go2")return toast("Onboard memories require GO:2.");memories.showModal();});
  initializeLooper();
  showConnection();
}
function title(value) { return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/-/g, " ").replace(/^./, c => c.toUpperCase()); }
function showConnection() {
  $("#connect-page").hidden = false; $("#tabs").hidden = true;
  for (const page of Object.values(pages)) page.hidden = true;
  connected = false; $(".top-actions").hidden = true;
}
function selectTab(name) {
  activeTab = name;
  if (!connected) return;
  for (const [key, page] of Object.entries(pages)) {
    page.hidden = key !== name;
    const tab = $("#tab-" + key); tab.setAttribute("aria-selected", String(key === name)); tab.tabIndex = key === name ? 0 : -1;
  }
  if (name === "Tones") renderLibrary();
  $(".top-actions").hidden = name !== "Pedals";
}
async function updateConnection() {
  $("#amp-memories-open").hidden = state.amp.profile !== "go2";
  const memory=state.amp.memory;
  $("#amp-memories-open").textContent = "Onboard memories" + (memory ? ` · Current: ${memory.bank}${memory.channel}` : " · Bank / A B C");
  const valid = state.amp.status === "connected" && state.amp.profile === draft.amp.profile;
  // A requested reread retains the editor until the read succeeds or fails.
  if (!valid) { if (state.amp.status !== "checking" || !connected) showConnection(); return; }
  if (schemaProfile !== state.amp.profile) {
    schema = await api("/api/amp/schema?profile=" + state.amp.profile); schemaProfile = state.amp.profile;
    ampGroups = [...new Set(Object.values(schema).map(p=>p.group || "Amp"))];
    ampView = "home"; ampCategory = "Amp"; ampGroup = "Amp";
    editorDirty = false; ampBase = {};
  }
  if (!editorDirty && JSON.stringify(ampBase) !== JSON.stringify(state.amp_settings)) {
    ampBase = clone(state.amp_settings); ampDraft = clone(ampBase); ampStored = clone(state.amp_all_settings || ampBase); renderAmp();
  }
  else if (editorDirty && JSON.stringify(ampBase) !== JSON.stringify(state.amp_settings)) {
    // Refresh untouched sections while preserving each section's pending edits.
    let redraw = false;
    for (const group of ampGroups) {
      if (groupPending(group)) continue;
      const keys = Object.keys(schema).filter(key=>(schema[key].group || "Amp")===group);
      if (!keys.some(key=>ampBase[key] !== state.amp_settings[key])) continue;
      for (const key of keys) {
        delete ampBase[key]; delete ampDraft[key]; delete ampStored[key];
        if (state.amp_settings[key] !== undefined) ampBase[key] = ampDraft[key] = state.amp_settings[key];
        const stored=(state.amp_all_settings || state.amp_settings)[key];
        if(stored !== undefined)ampStored[key]=stored;
      }
      redraw ||= ampView === "controls" && ampGroup === group;
    }
    if(redraw)renderAmp();
  }
  if (!connected) {
    connected = true; $("#connect-page").hidden = true; $("#tabs").hidden = false; selectTab(activeTab); renderAmp();
  }
  refreshAmpSummaries();
}
function ampCards(category = ampCategory) {
  const groups = category === "Equalizer" ? ["eq1", "eq2", "globalEq"] : category === "Effects" ? ["booster", "mod", "fx", "delay", "reverb", "pedalFx"] : ["Amp", "routing", "solo", "contour", "noiseGate", "stageFeel", "usbAudio"];
  return groups.filter(group => ampGroups.includes(group));
}
function openAmpCard(group, category) {
  ampGroup = group; ampCategory = category; ampView = "controls";
  renderAmp();
  $("#amp-card-title").focus();
}
function moveAmpCard(direction) {
  const cards = ampCards(), index = cards.indexOf(ampGroup === "delay2" ? "delay" : ampGroup);
  const next = cards[index + direction];
  if (next) openAmpCard(next, ampCategory);
}
function ampMenuCard(name, detail, handler, summary) {
  const card = button("", handler, "amp-menu-card");
  card.setAttribute("aria-label", name);
  card.append(element("strong", {text:name}), element("span", {class:"amp-card-summary", "data-amp-summary":summary || name}));
  return card;
}
function renderAmpNavigation() {
  const home = ampView === "home", effects = ampView === "effects";
  $("#amp-back").hidden = home;
  $("#amp-back").textContent = !home && !effects && ampCategory === "Effects" ? "← Effects" : "← Sections";
  $("#amp-location").textContent = home ? "Tone editor" : effects ? "Effects" : ampCategory;
  $("#amp-card-menu").hidden = !home && !effects;
  $("#amp-detail").hidden = home || effects;
  if (home) {
    $("#amp-card-menu").className = "amp-card-menu";
    $("#amp-card-menu").replaceChildren(
      ampMenuCard("Amp", "Model, volume & tone", () => openAmpCard("Amp", "Amp"), "ampOverview"),
      ampMenuCard("Equalizer", "EQ 1, EQ 2 & global EQ", () => { const group=ampCards("Equalizer")[0]; if(group)openAmpCard(group,"Equalizer"); }),
      ampMenuCard("Effects", "Choose your pedals & settings", () => { ampView = "effects"; renderAmp(); }),
    );
    $("#amp-card-menu").children[1].disabled = ampCards("Equalizer").length === 0;
  } else if (effects) {
    $("#amp-card-menu").className = "amp-card-menu effects-menu";
    const descriptions = {booster:"Drive & boost", mod:"Modulation", fx:"Additional effects", delay:"Delay 1 & Delay 2", reverb:"Space & ambience", pedalFx:"Wah & pitch bend"};
    const cards = ampCards("Effects").filter(group=>group!=="pedalFx").map(group => ampMenuCard(ampGroupNames[group], descriptions[group], () => openAmpCard(group,"Effects"),group));
    if (ampGroups.includes("pedalFx")) cards.push(button("Pedal FX · Wah & pitch bend",()=>openAmpCard("pedalFx","Effects"),"text-button pedal-fx-link"));
    $("#amp-card-menu").replaceChildren(...cards);
    if (ampGroups.includes("pedalFx")) {
      const link=$("#amp-card-menu .pedal-fx-link");
      link.replaceChildren(element("b",{text:"Pedal FX"}),element("span",{"data-amp-summary":"pedalFx",class:"pedal-fx-summary"}));
    }
  } else {
    const cards = ampCards(), index = cards.indexOf(ampGroup === "delay2" ? "delay" : ampGroup);
    $("#amp-card-title").textContent = ampGroupNames[ampGroup] || title(ampGroup);
    $("#amp-card-title").tabIndex = -1;
    $("#amp-card-position").textContent = `${index + 1} of ${cards.length}`;
    for (const [id, boundary] of [["amp-previous",index <= 0],["amp-next",index >= cards.length - 1]]) {
      $("#" + id).dataset.boundary = String(boundary);
      $("#" + id).disabled = boundary || busy || state?.amp_busy;
    }
  }
  $("#amp-card-live").dataset.ampSummary = ampGroup;
  refreshAmpSummaries();
  const delay = ampView === "controls" && ["delay", "delay2"].includes(ampGroup);
  $("#delay-slots").hidden = !delay;
  if (delay) $("#delay-slots").replaceChildren(...["delay","delay2"].filter(group=>ampGroups.includes(group)).map(group=> {
    const node=button(group === "delay" ? "Delay 1" : "Delay 2",()=>openAmpCard(group,"Effects"),"button secondary");
    node.setAttribute("aria-pressed",String(group===ampGroup));return node;
  }));
}
function liveValue(value) {
  return value === undefined || value === null ? "—" : typeof value === "boolean" ? value ? "On" : "Off" : typeof value === "string" ? title(value) : String(value);
}
function liveEnabled(group, settings) {
  if (typeof settings[group + "Enabled"] === "boolean") return settings[group + "Enabled"];
  if (typeof settings[group] === "number") return settings[group] >= 0;
  return null;
}
function groupPending(group) {
  return editorDirty && Object.entries(schema).some(([key,p])=>(p.group || "Amp") === group && ampDraft[key] !== ampBase[key]);
}
function liveRow(name, value, enabled) {
  const children=[];
  if (enabled !== undefined) children.push(element("span",{class:"onoff " + (enabled === true ? "is-on" : enabled === false ? "is-off" : "is-unknown"),text:enabled === true ? "On" : enabled === false ? "Off" : "—"}));
  children.push(element("span",{class:"summary-value",text:(name ? name + " · " : "") + value}));
  return element("span",{class:"card-summary-row"},children);
}
function liveSummary(group, settings) {
  const rows=[];
  const add=(name,value,enabled)=>rows.push(liveRow(name,value,enabled));
  const value=key=>liveValue(settings[key]);
  const eq=key=>{
    const type=settings[key+"Type"], level=settings[key === "globalEq" ? "globalEqLevel" : key+(type === "graphic" ? "Graphic" : "Parametric")+"Level"];
    add(ampGroupNames[key],key === "globalEq" ? "Parametric" : value(key+"Type"),liveEnabled(key,settings));
    if (level !== undefined) add("Level",`${level} dB${settings[key+"Position"] ? " · " + value(key+"Position") : ""}`);
  };
  if (["Amp", "ampOverview"].includes(group)) {
    add("",value("ampType") + (settings.variation ? " · Variation" : ""));
    add("Gain",value("gain") + " · Volume " + value("volume"));
    add("Bass",value("bass") + " · Mid " + value("middle") + " · Treble " + value("treble"));
    add("Presence",value("presence"));
  } else if (group === "Equalizer") {
    for (const key of ["eq1","eq2","globalEq"].filter(key=>ampGroups.includes(key))) eq(key);
  } else if (group === "Effects") {
    for (const key of ["booster","mod","fx","delay","delay2","reverb"].filter(key=>ampGroups.includes(key))) add(ampGroupNames[key],value(key+"Type"),liveEnabled(key,settings));
  } else if (["eq1","eq2","globalEq"].includes(group)) {
    eq(group);
  } else if (["booster","mod","fx","delay","delay2","reverb","pedalFx"].includes(group)) {
    const groups=group === "delay" && ampGroups.includes("delay2") ? ["delay","delay2"] : [group];
    for (const key of groups) {
      add(groups.length>1 ? (key === "delay" ? "Delay 1" : "Delay 2") : "",value(key+"Type"),liveEnabled(key,settings));
      if (key === "booster") add("Drive",value("boosterDrive") + " · Level " + value("boosterLevel"));
      else if (key.startsWith("delay")) add("",value(key+"TimeMs") + " ms · Level " + value(key+"Level"));
      else if (key === "reverb") add("",(settings.reverbTimeMs === undefined ? "—" : settings.reverbTimeMs/1000) + " s · Level " + value("reverbLevel"));
      else if (["mod","fx"].includes(key)) {
        const prefix=key + String(settings[key+"Type"] || "").replace(/(^|-)([a-z])/g,(_,dash,c)=>c.toUpperCase());
        const model=["Model","Mode","Stage"].map(name=>prefix+name).find(field=>schema[field]?.values && settings[field] !== undefined);
        if(model)add(controlTitle(model,schema[model]),value(model));
        const fields=Object.keys(schema).filter(field=>field.startsWith(prefix) && settings[field] !== undefined && !schema[field].values && !schema[field].boolean).slice(0,2);
        for (const field of fields) add(controlTitle(field,schema[field]),value(field));
      } else if (key === "pedalFx") add("Position",value("pedalFxPosition"));
    }
  } else {
    const keys={routing:["chain","cabinetResonance","masterKey"],solo:["soloEnabled","soloLevel","soloEqEnabled"],contour:["contourSelect"],noiseGate:["noiseGateEnabled","noiseGateThreshold","noiseGateRelease"],stageFeel:["stageFeelType"],usbAudio:["usbInputLevel","usbOutputLevel","usbLoopback"]}[group] || [];
    for (const key of keys) if (settings[key] !== undefined) add(controlTitle(key,schema[key] || {}),value(key));
  }
  const pending = group === "ampOverview" ? ampCards("Amp").some(groupPending) : group === "Equalizer" ? ["eq1","eq2","globalEq"].some(groupPending) : group === "Effects" ? ampCards("Effects").concat("delay2").some(groupPending) : groupPending(group) || group === "delay" && groupPending("delay2");
  if (pending) rows.push(element("span",{class:"pending-settings",text:"Unapplied changes"}));
  return rows;
}
function refreshAmpSummaries() {
  const settings=state?.amp_settings || ampBase;
  for (const node of document.querySelectorAll("[data-amp-summary]")) {
    const rows=liveSummary(node.dataset.ampSummary,settings);
    const key=rows.map(row=>row.textContent).join("|");
    if (node.dataset.summaryKey !== key) {
      node.replaceChildren(...rows);node.dataset.summaryKey=key;
    }
  }
}
function controlTitle(key, p) {
  if (p.label && !p.algorithm) return p.label;
  let name = key;
  if (p.group && name.startsWith(p.group)) name = name.slice(p.group.length);
  if (p.algorithm) {
    const algorithm = p.algorithm.replace(/(^|-)([a-z])/g, (_, dash, c)=>c.toUpperCase());
    if (name.startsWith(algorithm)) name = name.slice(algorithm.length);
  }
  return title(name).replace("Ms", " (ms)") + (p.unit && p.unit !== "ms" ? " (" + p.unit + ")" : "");
}
function renderAmp() {
  renderAmpNavigation();
  if (ampView !== "controls") return;
  const group = ampGroup;
  const controls = [];
  for (const [key, p] of Object.entries(schema)) {
    if ((p.group || "Amp") !== group || (p.algorithm && p.algorithm !== ampDraft[p.group + "Type"])) continue;
    let control;
    if (p.values) { control = element("select"); control.append(...Object.keys(p.values).map(v => option(v, title(v)))); control.value = ampDraft[key] ?? ""; }
    else if (p.boolean) { control = element("input", {type: "checkbox"}); control.checked = !!ampDraft[key]; }
    else { control = element("input", {type: "number", min: p.min, max: p.max, step: p.step || p.scale || 1}); control.value = ampDraft[key] ?? ""; }
    control.disabled = p.writable === false;
    control.setAttribute("aria-label", p.label || title(key));
    control.addEventListener("change", () => {
      ampDraft[key] = p.boolean ? control.checked : p.values ? control.value : Number(control.value);
      ampStored[key] = ampDraft[key];
      editorDirty = true; $("#editor-message").textContent = "Unapplied changes";
      refreshAmpSummaries();
      if (key === p.group + "Type") {
        for (const [field, spec] of Object.entries(schema)) if (spec.group === p.group && spec.algorithm) {
          delete ampDraft[field];
          if (spec.algorithm === ampDraft[key] && ampStored[field] !== undefined) ampDraft[field] = ampStored[field];
        }
        renderAmp();
      }
    });
    const name = controlTitle(key, p);
    control.setAttribute("aria-label", name);
    if (!p.values && !p.boolean && p.writable !== false) {
      const slider = element("input", {type:"range",min:p.min,max:p.max,step:p.step || p.scale || 1,value:ampDraft[key] ?? p.min,"aria-label":name + " slider"});
      slider.addEventListener("input",()=>{control.value=slider.value;});
      slider.addEventListener("change",()=>control.dispatchEvent(new Event("change")));
      control.addEventListener("input",()=>{slider.value=control.value;});
      controls.push(label(name,element("div",{class:"knob-control"},[slider,control])));
    } else controls.push(label(name, control));
  }

  $("#amp-controls").replaceChildren(...controls);
  if (!editorDirty) $("#editor-message").textContent = Object.values(schema).some(p=>p.group===group && p.scope==="system") ? "Amp-wide settings · saved separately from tones" : "Edit the live tone · Apply changes, then Save to library";
}
async function applyAmp() {
  if (busy || state.amp_busy) return;
  const changes = Object.fromEntries(Object.entries(ampDraft).filter(([key, value]) => ampBase[key] !== value));
  if (!Object.keys(changes).length) { editorDirty = false; renderAmp(); return; }
  setBusy(true); $("#apply-amp").disabled = true;
  try {
    const result = await api("/api/amp/edit", {changes});
    ampBase = clone(result.settings); ampDraft = clone(ampBase); ampStored = clone(result.allSettings || ampBase); editorDirty = false;
    await poll(); renderAmp(); toast("Amp settings applied.");
  } finally { setBusy(false); }
}
async function loadLibraryTone(tone) {
  if (busy || state.amp_busy) return;
  if (editorDirty && !confirm("Replace unapplied amp changes with this tone?")) return;
  setBusy(true);
  try {
    const result = await api("/api/amp/edit", {file: tone.file});
    ampBase = clone(result.settings); ampDraft = clone(ampBase); ampStored = clone(result.allSettings || ampBase); editorDirty = false;
    await poll(); openAmpCard("Amp", "Amp"); selectTab("Amp"); toast("Tone loaded.");
  } finally { setBusy(false); }
}
async function exportTone(tone) {
  const document = await api("/api/tone?file=" + encodeURIComponent(tone.file));
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + "\n"], {type: "application/json"}));
  element("a", {href: url, download: tone.name + ".json"}).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
