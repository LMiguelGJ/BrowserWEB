const fs = require('node:fs');
const vm = require('node:vm');

function createHarness(serverUrl = 'http://localhost:3000', fetchImpl) {
  const requests = [], sockets = [], timers = [], intervals = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code, wasClean: true }); }
    fail() { this.onerror?.(new Error('socket failure')); this.close(); }
  }
  const context = { window: {}, WebSocket: FakeWebSocket, console, URL,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      if (url.includes('/api/status')) return { ok:true, json:async()=>({success:true,browser:'connected'}) };
      if (url.includes('/api/screenshot')) return { ok:true, json:async()=>({success:true,screenshot:'manual-image'}) };
      return { ok:true, json:async()=>({success:true}) };
    },
    setTimeout(fn, delay) { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setInterval(fn, delay) { const timer={fn,delay,cancelled:false}; intervals.push(timer); return timer; }, clearInterval(timer){if(timer)timer.cancelled=true;}, setImmediate, Date };
  vm.runInNewContext(fs.readFileSync('public/PyRockHTTP.js', 'utf8'), context, { filename: 'public/PyRockHTTP.js' });
  const client = new context.window.PyRockHTTP({ serverUrl, maxRetries: 0, statusPollIntervalMs: 50 });
  return { client, requests, sockets, timers, timeouts:timers, intervals };
}

function createScriptHarness({ sessions = [{ id: 's1', name: 'One', url: 'https://one.test' }], defaultId, max, storedId = null, onExecute, network } = {}) {
  const elements = new Map(), listeners = new Map(), local = new Map(storedId ? [['pyrock.activeSession', storedId]] : []), operations = [], timers = [], clicks = [], presses = [], requests = [];
  let client, options;
  function element(tag = 'div') {
    const handlers = new Map(), attrs = new Map(), classes = new Set();
    return { tag, children: [], style: {}, dataset: {}, value: '', textContent: '', title: '', disabled: false, naturalWidth: 0, naturalHeight: 0, rect:{left:0,top:0,width:0,height:0}, clientLeft:0, clientTop:0, complete:false,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle(x, force) { const on = force === undefined ? !classes.has(x) : force; if (on) classes.add(x); else classes.delete(x); return on; } },
      setAttribute(k,v) { attrs.set(k,String(v)); }, getAttribute(k) { return attrs.get(k) ?? null; },
      addEventListener(type, fn, opts={}) { handlers.set(type,[...(handlers.get(type)||[]),{fn,once:opts.once===true}]); }, removeEventListener(type,fn) { handlers.set(type,(handlers.get(type)||[]).filter(x=>x.fn!==fn)); }, listenerCount(type){return (handlers.get(type)||[]).length;},
      dispatch(type, extra={}) { for (const entry of [...(handlers.get(type)||[])]) { entry.fn({ type, target:this, ...extra }); if(entry.once)this.removeEventListener(type,entry.fn); } },
      append(...els) { this.children.push(...els); }, appendChild(el) { this.children.push(el); el.parentNode=this; }, prepend(el) { this.children.unshift(el); el.parentNode=this; },
      replaceChildren(...els) { this.children=els; }, remove() { if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(x=>x!==this); },
      querySelector(selector) { if(selector==='input') return this.children.find(x=>x.tag==='input')||null; return null; }, focus() { document.activeElement=this; }, blur() { this.dispatch('blur'); }, getBoundingClientRect(){return this.rect;},
      scrollHeight:0, click(){} };
  }
  const document = { hidden:false, activeElement:null,
    getElementById(id) { if(!elements.has(id)) elements.set(id,element()); return elements.get(id); },
    createElement(tag) { return element(tag); }, querySelector(sel) { if(sel==='.preview-container') return this.getElementById('.preview-container'); return null; },
    addEventListener(type,fn){ listeners.set(type,[...(listeners.get(type)||[]),fn]); }, dispatch(type,event={}){for(const f of listeners.get(type)||[])f({type,...event});} };
  const windowListeners=new Map();
  const window={ PyRockConfig:{serverUrl:'http://localhost'}, addEventListener(type,fn){windowListeners.set(type,[...(windowListeners.get(type)||[]),fn]);}, async dispatch(type){for(const f of windowListeners.get(type)||[]) await f();} };
  const networkResponse = path => (network && typeof network === 'function' ? network(path) : network) || {};
  class FakeClient {
    constructor(o){options=o;client=this;this.sessionId=o.sessionId;this.isConnected=false;}
    async connect(){this.isConnected=true;return true;} disconnect(){this.isConnected=false;}
    switchSession(id){operations.push(['switch',id]);this.sessionId=id;}
    forSession(id){operations.push(['bind',id]);return {sessionId:id, marker:id};}
    async listSessions(){return {sessions: sessions.slice(), default:defaultId||sessions[0]?.id, max:max||5};}
    async createSession(name){operations.push(['create',name]);const s={id:`s${sessions.length+1}`,name:name||'Default',url:''};sessions.push(s);return {session:s};}
    async closeSession(id){operations.push(['close',id]);sessions.splice(sessions.findIndex(s=>s.id===id),1);}
    async initBrowser(){operations.push(['restart',this.sessionId]);}
    async click(x,y){clicks.push({x,y});operations.push(['click',this.sessionId,x,y]);}
    async pressKey(key){presses.push(key);operations.push(['key',this.sessionId,key]);}
    async makeRequest(path){requests.push(path);return networkResponse(path);}
  }
  class FakeParser {
    constructor(pyRock, indicators){this.pyRock=pyRock;this.visualIndicators=indicators;this.commands=[];this.currentLine=0;}
    loadScript(){return [{lineNumber:1,originalLine:'click'}];}
    async executeCommand(){operations.push(['execute',this.pyRock.sessionId]);await onExecute?.();this.visualIndicators.showClickIndicator(1,2);}
  }
  const context={document,window,localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v)},PyRockHTTP:FakeClient,PyRockScriptParser:FakeParser,console:{log(){},error(){}},Date,URL,
    setTimeout(fn,delay){const t={fn,delay,cancelled:false};timers.push(t);return t;},clearTimeout(t){if(t)t.cancelled=true;},setImmediate};
  vm.runInNewContext(`${fs.readFileSync('public/script.js','utf8')}\nwindow.__testApi={refreshSessions,activateSession,addSessionInline,executeScript,initBrowser,showDiagnosis,showPreviewMode,renderNetwork,openNetworkPanel};`,context,{filename:'public/script.js'});
  return {document,elements,window,context,operations,timers,local,clicks,presses, get client(){return client;},get options(){return options;}, async load(){await window.dispatch('load');return options;}, api:()=>window.__testApi};
}
module.exports={createHarness,createScriptHarness};
