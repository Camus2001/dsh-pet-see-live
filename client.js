/**
 * dsh-pet-see-live — 设置页
 *
 * 只在 DSH 设置里加一个分区，两个控件：语音识别开关、DSH 聚焦时暂停识别。
 * 其余采集/拼图/听音细节全部沿用 see-now 自己的设置页与配置文件。
 * 数据来自同源 /api/pet-see-live/*，与 see-now 的设置页结构一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-see-live',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback } = React;

    const NS = 'settings.petSeeLive';
    const API = '/api/pet-see-live';
    const inject = ['slots', 'locale'];

    const TEXT = {
      nav: 'dsh-pet-see-live',
      title: '宠物看屏与听音',
      desc: '让 pet 实时看屏幕、听同期声音并点评。节奏、fps、拼图等其余参数仍跟随 see-now 的设置。',
      listen: '语音识别（听同期声音）',
      listenHint: '开启后复用 see-now 的音频采集，识别也沿用 see-now 设置页的转写后端（宿主 SenseVoice 或 ~/.dsh/asr.json），pet 会把听到的话和画面一起点评。Windows 需 numpy + pyaudiowpatch。',
      pauseOnFocus: 'DSH 聚焦时暂停识别',
      pauseOnFocusHint: '开启后，当 DSH 主窗口处于系统前台时自动暂停抓屏与听音，焦点离开后恢复（桌宠窗口不算）。由窗口焦点事件判定，DSH 界面没打开时不会暂停。',
      sessionReset: 'pet 会话记忆超限自动重置',
      sessionResetHint: '仅适用于dsh-ntr的acp会话。开启后，pet 的acp会话上下文超过阈值将会清空，人设与设置不受影响。使用api时本设置不起作用。',
      sessionResetThreshold: '重置阈值',
      restart: '听音 / 暂停改动需重启 DSH；会话重置设置即时生效。',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败',
      loadFailed: '读取设置失败',
      loading: '载入中…',
    };
    const t = key => TEXT[key] ?? key;

    function Row({ title, hint, children }) {
      return h('div', { style: { marginBottom: 20 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, title),
        h('div', { style: { marginBottom: 8 } }, children),
        hint ? h('div', { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.5 } }, hint) : null,
      );
    }

    function SettingsPage() {
      const [values, setValues] = useState(null);
      const [err, setErr] = useState('');
      const [state, setState] = useState('');

      useEffect(() => {
        let alive = true;
        const pick = j => ({
          listenEnabled: j.listenEnabled === true,
          pauseOnFocus: j.pauseOnFocus !== false,
          sessionResetEnabled: j.sessionResetEnabled === true,
          sessionResetThreshold: Number(j.sessionResetThreshold) || 200000,
        });
        fetch(`${API}/status`)
          .then(r => r.json())
          .then(j => {
            if (!alive) return;
            if (j && j.ok) setValues(pick(j));
            else setErr(t('loadFailed'));
          })
          .catch(() => { if (alive) setErr(t('loadFailed')); });
        return () => { alive = false; };
      }, []);

      const save = useCallback(patch => {
        setState(t('saving'));
        setErr('');
        fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(r => r.json())
          .then(j => {
            if (j && j.ok) {
              setValues({
                listenEnabled: j.listenEnabled === true,
                pauseOnFocus: j.pauseOnFocus !== false,
                sessionResetEnabled: j.sessionResetEnabled === true,
                sessionResetThreshold: Number(j.sessionResetThreshold) || 200000,
              });
              setState(t('saved'));
            } else {
              setState(t('failed'));
              setErr((j && j.reason) || t('failed'));
            }
          })
          .catch(() => setState(t('failed')));
      }, []);

      return h('div', { style: { maxWidth: 560, lineHeight: 1.6 } },
        h('h3', null, t('title')),
        h('p', { style: { opacity: 0.75, fontSize: 13 } }, t('desc')),
        err ? h('p', { style: { color: '#e55' } }, err) : null,
        values === null
          ? h('p', null, t('loading'))
          : h('div', null,
            h(Row, {
              title: t('listen'),
              hint: t('listenHint'),
            }, h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'checkbox',
                checked: values.listenEnabled === true,
                onChange: e => save({ listenEnabled: e.target.checked }),
              }),
              h('span', null, values.listenEnabled ? '开启' : '关闭'),
            )),
            h(Row, {
              title: t('pauseOnFocus'),
              hint: t('pauseOnFocusHint'),
            }, h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'checkbox',
                checked: values.pauseOnFocus !== false,
                onChange: e => save({ pauseOnFocus: e.target.checked }),
              }),
              h('span', null, values.pauseOnFocus !== false ? '开启' : '关闭'),
            )),
            h(Row, {
              title: t('sessionReset'),
              hint: t('sessionResetHint'),
            }, h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('input', {
                  type: 'checkbox',
                  checked: values.sessionResetEnabled === true,
                  onChange: e => save({ sessionResetEnabled: e.target.checked }),
                }),
                h('span', null, values.sessionResetEnabled === true ? '开启' : '关闭'),
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { opacity: 0.75, fontSize: 13 } }, t('sessionResetThreshold')),
                h('select', {
                  value: String(values.sessionResetThreshold || 200000),
                  disabled: values.sessionResetEnabled !== true,
                  onChange: e => save({ sessionResetThreshold: Number(e.target.value) }),
                  style: { padding: '4px 8px' },
                }, [['64k', 65536], ['128k', 131072], ['200k', 200000], ['256k', 262144], ['300k', 300000]].map(([label, n]) =>
                  h('option', { key: n, value: String(n) }, `${label} tokens`)
                )),
              ),
            )),
          ),
        h('p', { style: { opacity: 0.65, fontSize: 12, marginTop: 16 } },
          `${state ? state + ' · ' : ''}${t('restart')}`),
      );
    }

    const FOCUS_BEAT_MS = 15000;

    // 把 DSH 主窗口是否在前台报给宿主：focus/blur/visibilitychange 立刻上报，之后每 15s 心跳，
    // 宿主 30s 收不到就按"不在前台"处理。
    function startFocusReporting(ctx) {
      let stopped = false;
      let timer = null;
      const post = (focused) => {
        if (stopped) return;
        fetch(`${API}/focus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ focused }),
        }).catch(() => { /* 宿主没挂上或鉴权失败时别刷错误 */ });
      };
      const report = () => post(document.hasFocus() === true);
      window.addEventListener('focus', report);
      window.addEventListener('blur', report);
      document.addEventListener('visibilitychange', report);
      report();
      timer = setInterval(report, FOCUS_BEAT_MS);
      const stop = () => {
        stopped = true;
        clearInterval(timer);
        window.removeEventListener('focus', report);
        window.removeEventListener('blur', report);
        document.removeEventListener('visibilitychange', report);
      };
      try { ctx.effect?.(() => stop); } catch { /* 老宿主没有 effect 就随页面卸载 */ }
    }

    function apply(ctx) {
      startFocusReporting(ctx);
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'pet-see-live',
          order: 44,
          label: () => t('nav'),
          locale: NS,
        },
        () => h(SettingsPage),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-pet-see-live';
    return module.exports;
  },
});
