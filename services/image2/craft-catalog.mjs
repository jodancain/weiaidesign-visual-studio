import { readFileSync } from 'node:fs';

// These are protocol mappings, not claims that every desktop feature is headless.
// The actual tool and command lists are read from the pinned executable at runtime.
const mappings = {
  photocraft: { extension: 'pcraft', roots: true, run: 'command_run', list: 'command_list', new: ['doc_new', { width: 800, height: 600 }], open: 'doc_open', save: 'doc_save', preview: ['render_preview', { max_side: 1024 }], inspect: 'doc_inspect' },
  vectorcraft: { extension: 'vectorcraft', roots: true, run: 'command_run', list: 'command_list', new: ['file.new', { width: 800, height: 600 }], open: 'open_file', save: 'save_file', preview: ['render_preview', { max_side: 1024 }], inspect: 'doc_inspect' },
  filmcraft: { extension: 'fcproj', run: 'command_run', list: 'command_list', new: ['file.newProject', {}], open: 'file.open', save: 'file.saveAs', preview: ['render_preview', {}], inspect: 'doc_inspect' },
  lightcraft: { extension: 'lightcraft', library: true, run: 'command_run', list: 'command_list', preview: ['render_preview', { max_side: 1024 }], inspect: 'doc_inspect' },
  pdfcraft: { extension: 'pdf', run: 'command_run', list: 'command_list', new: ['doc_create', { from: 'blank', pages: 1, width: 612, height: 792 }], open: 'doc_open', save: 'doc_save', preview: ['render_preview', { max_side: 1024 }], inspect: 'doc_inspect', docId: true },
  effectcraft: { extension: 'ecproj', roots: true, run: 'command_run', list: 'command_list', new: ['open_project', { new: true }], open: 'open_project', save: 'save_project', preview: ['render_preview', {}], inspect: 'doc_inspect' },
  designcraft: { extension: 'designcraft', run: 'execute', list: 'list_commands', new: ['new_document', {}], open: 'open_document', save: 'save_document', preview: ['render_page', { page: 0, scale: 1 }], inspect: 'inspect_document' },
  figcraft: { extension: 'figcraft', run: 'run_command', list: 'list_commands', new: ['file.new', {}], open: 'open_file', save: 'save_file', preview: ['export', { format: 'png', scale: 1 }], inspect: 'inspect_document' },
  wordcraft: { extension: 'docx', roots: true, run: 'execute', list: 'list_commands', new: ['new_document', { template: 'blank' }], open: 'open_document', save: 'save_document', preview: ['render_page', { page: 1, scale: 1 }], inspect: 'inspect_document' },
  soundcraft: { extension: 'scraft', roots: true, run: 'execute', list: 'list_commands', new: ['new_session', { name: 'Untitled', sample_rate: 48000 }], open: 'open_session', save: 'save_session', inspect: 'inspect_session' },
  deckcraft: { extension: 'deckcraft', run: 'run_command', list: 'list_commands', new: ['new_presentation', {}], open: 'open_presentation', save: 'save_presentation', preview: ['render_slide', { slide: 0, scale: 1 }], inspect: 'inspect_document' },
  cadcraft: { extension: 'dxf', run: 'execute', list: 'list_commands', new: ['new_drawing', { metric: true }], open: 'open', save: 'save', preview: ['render', { width: 1024, height: 768 }], inspect: 'inspect_drawing' },
  gridcraft: { extension: 'json', run: 'execute_command', list: 'list_commands', new: ['new_workbook', {}], open: 'open_workbook', save: 'save_workbook', inspect: 'inspect_workbook' },
};

export function craftEngines() {
  const lock = JSON.parse(readFileSync(new URL('./craft-engines.lock.json', import.meta.url), 'utf8'));
  return lock.engines.map(engine => ({ ...engine, ...mappings[engine.id], nativeExtension: mappings[engine.id].extension }));
}

export function craftEngine(id) {
  const engine = craftEngines().find(entry => entry.id === id);
  if (!engine) throw Object.assign(new Error('Unknown ArtCraft engine'), { code: 'CRAFT_ENGINE_UNKNOWN', statusCode: 400 });
  return engine;
}

const GENERIC = new Set(['command_run', 'run_command', 'execute', 'execute_command', 'command_batch', 'command.batch', 'doc_batch', 'execute_batch', 'batch', 'script', 'run_script', 'execute_script', 'command_line', 'control']);
const UNSAFE = /(?:^|[._])(?:ui|appOnly|shell|execProcess|script|javascript|python|macro|plugin|plugins|extension|extensions|network|server|collab|collaboration|publish|share|upload|download|remote|cloud|account|login|logout|auth|print|prefs|preferences|settings|quit|exit|launch|openUrl|openURL|reveal|browse|zotero|refreshAll|connection|connections|externalData|webQuery)(?:[._]|$)/i;
const UNSAFE_WORDS = /(?:desktop app only|APP_ONLY|requires a running|connected desktop|live app|running desktop)/i;
const UI_TOOLS = new Set(['screenshot', 'click', 'drag', 'key', 'pointer', 'pointer_gesture', 'select_tool', 'menu_invoke', 'invoke_menu', 'press_key', 'inspect_ui', 'type_key', 'script_ui']);

export function craftCommandUnavailableReason(id, description = '', engineId) {
  if (engineId === 'cadcraft' && ['attach', '3dorbit', 'orbit'].includes(id)) return 'CRAFT_UPSTREAM_NOT_IMPLEMENTED';
  // Match the pinned PhotoCraft automation boundary, which rejects filesystem
  // engine commands even when our surrounding OS sandbox would allow the files.
  // Its doc_open/doc_save/doc_export MCP tools are the supported file route.
  if (engineId === 'photocraft') {
    const fileCommands = new Set(['file.new', 'file.close', 'file.closeAll', 'file.closeOthers', 'file.fileInfo', 'file.automate.fitImage', 'file.automate.conditionalModeChange', 'file.automate.cropAndStraightenPhotos', 'file.scripts.flattenAllLayerEffects', 'file.scripts.flattenAllMasks', 'file.scripts.deleteAllEmptyLayers']);
    const smartCommands = new Set(['layer.smartObjects.convertToSmartObject', 'layer.smartObjects.editContents', 'layer.smartObjects.convertToLayers', 'layer.smartObjects.saveContents']);
    if ((id.startsWith('file.') && !fileCommands.has(id)) || (id.startsWith('layer.smartObjects.') && !smartCommands.has(id)) || ['pattern.import', 'pattern.export', 'edit.presets.migratePresets', 'measurementLog.export', 'layer.videoLayers.newVideoLayerFromFile', 'layer.videoLayers.replaceFootage', 'layer.videoLayers.reloadFrame', 'color.profileMismatch', 'edit.colorSettings', 'edit.installedProfiles'].includes(id)) return 'CRAFT_NATIVE_AUTOMATION_UNSUPPORTED';
  }
  if (engineId === 'effectcraft' && ['file.runScript', 'file.installScript', 'file.installScriptUIPanel', 'file.uninstallScript', 'file.executeFile', 'layer.openSource', 'file.autoSave'].includes(id)) return 'CRAFT_NATIVE_AUTOMATION_UNSUPPORTED';
  if (engineId === 'pdfcraft' && /^(?:ocr_recognize(?:_files)?|ocr\.recognize(?:_batch)?)$/.test(id)) return 'CRAFT_MODEL_NOT_CONFIGURED';
  if (['js_run', 'js_eval', 'lisp_run', 'eval_script'].includes(id)) return 'CRAFT_SCRIPT_DISABLED';
  if (/(?:^|\.)revealInFinder$/.test(id)) return 'CRAFT_HOST_INTEGRATION_DISABLED';
  // Pinned upstream implementations: Photo's classical denoise and Film's
  // transcript editing are CPU algorithms. Only actual inference paths need models.
  if (engineId === 'lightcraft' && /^export\.(?:addToPhotos|photosImports)$/.test(id)) return 'CRAFT_HOST_INTEGRATION_DISABLED';
  if (engineId === 'lightcraft' && id === 'metadata.downloadPlaceNames') return 'CRAFT_NETWORK_DISABLED';
  if (engineId === 'lightcraft' && id === 'metadata.reverseGeocode') return 'CRAFT_DATASET_NOT_CONFIGURED';
  if (engineId === 'soundcraft' && /^(?:transport\.(?:play|stop|toggle|record|pause|half_speed|play_selection)|setup\.(?:hardware|playback_engine|peripherals|midi_studio|midi_beat_clock|midi_input_devices|disk_allocation)|mix\.(?:record_arm|input_monitor)|track\.(?:input|set_record_to_input_only)|options\.(?:midi_thru|midi_live_mode|low_latency_monitoring))$/.test(id)) return 'CRAFT_HOST_DEVICE_DISABLED';
  if (engineId === 'filmcraft' && /^(?:audio\.voiceover\.|trim\.playAround$)/.test(id)) return 'CRAFT_HOST_DEVICE_DISABLED';
  if (engineId === 'lightcraft' && /^(?:denoise\.|segment\.|faces\.(?:models|enable|detect|index|suggest|pump|evaluate|unnamed|person)(?:\.|$)|mask\.(?:objectPoint|refineDetail)$)/.test(id)) return 'CRAFT_MODEL_NOT_CONFIGURED';
  if (engineId === 'filmcraft' && /^(?:transcript\.(?:generate|downloadModel)|transcribe_audio)$/.test(id)) return 'CRAFT_MODEL_NOT_CONFIGURED';
  if (/^(?:script|scripting|lisp|macro|macros|actions?|automation)[.:_]/i.test(id) || /^(?:file\.automate\.(?:batch|createDroplet|runDroplet)|file\.scripts\.scriptEventsManager)$/.test(id)) return 'CRAFT_SCRIPT_DISABLED';
  return null;
}

export function isCraftCommandSafe(id, description = '', engineId) {
  return typeof id === 'string' && (/^[a-zA-Z][\w.:-]{0,159}$/.test(id) || (engineId === 'cadcraft' && id === '-xref'))
    && !GENERIC.has(id) && !UNSAFE.test(id) && !UNSAFE_WORDS.test(description) && !craftCommandUnavailableReason(id, description, engineId)
    && !/^(?:help|window|view|workspace|control|system|automation|extension|plugin|clipboard|action|actions|app|font\.scan|font\.rescan)\./i.test(id)
    && !/^(?:file\.(?:openRecent|recent|closeAll|revert|package|collect|dependencies|link|links)|library\.(?:open|new|switch|move|remove|delete|scan|rescan)|data\.(?:refresh|connect|connection|fromWeb|fromDatabase)|text\.fonts|fonts\.rescan)/i.test(id);
}

export function isCraftToolSafe(tool, engineId) {
  return !GENERIC.has(tool.name) && !UI_TOOLS.has(tool.name) && !tool.name.startsWith('cmd_')
    && !UNSAFE.test(tool.name) && !UNSAFE_WORDS.test(tool.description ?? '') && !craftCommandUnavailableReason(tool.name, tool.description ?? '', engineId)
    && !/^(?:ui_|inspect_ui|list_widgets|control|batch_|script|install|font_add)/i.test(tool.name);
}

export function craftLaunchArgs(engine, workDir) {
  const args = ['mcp'];
  if (engine.id === 'vectorcraft') args.push('--headless');
  if (engine.id === 'lightcraft') args.push('--headless', '--compact', '--library', `${workDir}/library`);
  if (engine.roots) args.push('--automation-read-root', workDir, '--automation-write-root', workDir);
  return args;
}
