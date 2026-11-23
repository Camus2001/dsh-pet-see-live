/**
 * dsh-pet-see-live — 设置页
 *
 * 分区包含：听音、聚焦暂停、每只宠物的看图开关/风格、ACP 会话重置。
 * 宠物顺序与 dsh-pet 设置页一致；ACP 宠物同一时间只能启用一只。
 * 数据来自同源 /api/pet-see-live/*。
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

    const DEFAULT_STYLE = '自然随意地用短短一句说说你的想法，可以吐槽、夸奖或贬损。';

    const TEXT = {
      nav: 'dsh-pet-see-live',
      title: '宠物看屏与听音',
      desc: '让 pet 实时看屏幕、听同期声音并点评。节奏、fps、拼图等其余参数仍跟随 see-now 的设置。',
      listen: '语音识别（听同期声音）',
      listenHint: '开启后复用 see-now 的音频采集，识别也沿用 see-now 设置页的转写后端（宿主 SenseVoice 或 ~/.dsh/asr.json），pet 会把听到的话和画面一起点评。Windows 需 numpy + pyaudiowpatch。',
      pauseOnFocus: 'DSH 聚焦时暂停识别',
      pauseOnFocusHint: '开启后，当 DSH 主窗口处于系统前台时自动暂停抓屏与听音，焦点离开后恢复（桌宠窗口不算）。由窗口焦点事件判定，DSH 界面没打开时不会暂停。',
      petsTitle: '宠物看图说话',
      petsHint: '顺序与 dsh-pet 设置页一致。',
      lengthHint: '提示：人设 + 风格/篇幅 + 时间线合计不要超过 2000 字，否则 dsh-pet 会拒绝这条看图消息。',
      petOffline: '未读取到宠物，请确认 dsh-pet 在线。',
      refresh: '刷新',
      persona: '人设（来自 dsh-pet）',
      personaEmpty: '（dsh-pet 没有返回人设）',
      style: '风格 / 篇幅',
      styleHint: `留空使用默认：${DEFAULT_STYLE}`,
      enabled: '启用看图发图',
      acpLocked: '另一只 ACP 宠物已启用，先关闭它。',
      acpNote: 'ACP 宠物同一时间只能启用一只。',
      displayNone: '宠物当前 display=none，不会显示，也不会发图。',
      sessionReset: 'pet 会话记忆超限自动重置',
      sessionResetHint: '仅适用于dsh-ntr的acp会话。开启后，pet 的acp会话上下文超过阈值将会清空，人设与设置不受影响。使用api时本设置不起作用。',
      sessionResetThreshold: '重置阈值',
      clearAcp: '清空 ACP 会话',
      clearAcpHint: '关闭并删除共享的 dsh-pet ACP 会话；API 宠物不受影响。',
      confirmClear: '清空后 pet 的 ACP 对话上下文会丢失，确定继续？',
      clearing: '清空中…',
      cleared: '已清空',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败',
      loadFailed: '读取设置失败',
      loading: '载入中…',
      restart: '听音 / 暂停改动需重启 DSH；宠物开关、风格和 ACP 重置设置保存后即时生效。',
    };
    const t = key => TEXT[key] ?? key;

    const pick = (j) => ({
      listenEnabled: j.listenEnabled === true,
      pauseOnFocus: j.pauseOnFocus !== false,
      sessionResetEnabled: j.sessionResetEnabled === true,
      sessionResetThreshold: Number(j.sessionResetThreshold) || 200000,
      pets: Array.isArray(j.pets) ? j.pets.map(p => ({
        id: String(p.id || ''),
        name: String(p.name || p.id || ''),
        provider: String(p.provider || ''),
        display: String(p.display || 'desktop'),
        persona: typeof p.persona === 'string' ? p.persona : '',
        enabled: p.enabled === true,
        commentStyle: typeof p.commentStyle === 'string' ? p.commentStyle : '',
      })).filter(p => p.id !== '') : [],
    });

    const draftsOf = (pets) => {
      const out = {};
      for (const pet of pets) out[pet.id] = { enabled: pet.enabled === true, commentStyle: pet.commentStyle || '' };
      return out;
    };

    function Row({ title, hint, children }) {
      return h('div', { style: { marginBottom: 20 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, title),
        h('div', { style: { marginBottom: 8 } }, children),
        hint ? h('div', { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.5 } }, hint) : null,
      );
    }

    function SettingsPage() {
      const [values, setValues] = useState(null);
      const [drafts, setDrafts] = useState({});
      const [err, setErr] = useState('');
      const [state, setState] = useState('');
      const [clearing, setClearing] = useState(false);

      const load = useCallback(() => {
        setState(t('loading'));
        setErr('');
        fetch(`${API}/status`)
          .then(r => r.json())
          .then(j => {
            if (j && j.ok) {
              const next = pick(j);
              setValues(next);
              setDrafts(draftsOf(next.pets));
              setState('');
            } else {
              setErr(t('loadFailed'));
              setState('');
            }
          })
          .catch(() => { setErr(t('loadFailed')); setState(''); });
      }, []);

      useEffect(() => { load(); }, [load]);

      const updateValue = (patch) => setValues(prev => (prev ? { ...prev, ...patch } : prev));
      const updatePet = (id, patch) => setDrafts(prev => ({
        ...prev,
        [id]: { ...(prev[id] || { enabled: false, commentStyle: '' }), ...patch },
      }));

      const togglePet = (pet, checked) => {
        setDrafts(prev => {
          const next = { ...prev };
          if (pet.provider === 'acp' && checked) {
            for (const p of values.pets) {
              if (p.provider === 'acp') {
                next[p.id] = { ...(next[p.id] || {}), enabled: p.id === pet.id };
              }
            }
          } else {
            next[pet.id] = { ...(next[pet.id] || {}), enabled: checked };
          }
          return next;
        });
      };

      const saveAll = () => {
        if (!values) return;
        setState(t('saving'));
        setErr('');
        const payload = {
          listenEnabled: values.listenEnabled === true,
          pauseOnFocus: values.pauseOnFocus !== false,
          sessionResetEnabled: values.sessionResetEnabled === true,
          sessionResetThreshold: Number(values.sessionResetThreshold) || 200000,
          pets: drafts,
        };
        fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(r => r.json())
          .then(j => {
            if (j && j.ok) {
              const next = pick(j);
              setValues(next);
              setDrafts(draftsOf(next.pets));
              setState(t('saved'));
            } else {
              setState(t('failed'));
              setErr((j && j.reason) || t('failed'));
            }
          })
          .catch(() => { setState(t('failed')); setErr(t('failed')); });
      };

      const clearAcp = () => {
        if (!window.confirm(t('confirmClear'))) return;
        setClearing(true);
        setErr('');
        fetch(`${API}/clear-acp`, { method: 'POST' })
          .then(r => r.json())
          .then(j => {
            if (j && j.ok) setState(t('cleared'));
            else setErr((j && j.reason) || t('failed'));
          })
          .catch(() => setErr(t('failed')))
          .finally(() => setClearing(false));
      };

      if (values === null) {
        return h('div', { style: { maxWidth: 720, lineHeight: 1.6 } },
          h('h3', null, t('title')),
          h('p', { style: { opacity: 0.75, fontSize: 13 } }, t('desc')),
          err ? h('p', { style: { color: '#e55' } }, err) : null,
          h('p', null, t('loading')),
        );
      }

      const activeAcp = values.pets.find(p => p.provider === 'acp' && drafts[p.id]?.enabled === true);
      const activeAcpId = activeAcp ? activeAcp.id : '';
      const hasAcp = values.pets.some(p => p.provider === 'acp');

      return h('div', { style: { maxWidth: 720, lineHeight: 1.6 } },
        h('h3', null, t('title')),
        h('p', { style: { opacity: 0.75, fontSize: 13 } }, t('desc')),
        err ? h('p', { style: { color: '#e55' } }, err) : null,

        h(Row, { title: t('listen'), hint: t('listenHint') },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: values.listenEnabled === true,
              onChange: e => updateValue({ listenEnabled: e.target.checked }),
            }),
            h('span', null, values.listenEnabled ? '开启' : '关闭'),
          ),
        ),

        h(Row, { title: t('pauseOnFocus'), hint: t('pauseOnFocusHint') },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: values.pauseOnFocus !== false,
              onChange: e => updateValue({ pauseOnFocus: e.target.checked }),
            }),
            h('span', null, values.pauseOnFocus !== false ? '开启' : '关闭'),
          ),
        ),

        h('div', { style: { marginBottom: 20 } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('petsTitle')),
          h('div', { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.5, marginBottom: 10 } }, t('petsHint')),
          hasAcp ? h('div', { style: { opacity: 0.65, fontSize: 12, marginBottom: 10 } }, t('acpNote')) : null,
          h('div', { style: { opacity: 0.65, fontSize: 12, marginBottom: 10 } }, t('lengthHint')),
          values.pets.length === 0
            ? h('div', null,
              h('p', { style: { opacity: 0.7, fontSize: 13 } }, t('petOffline')),
              h('button', { onClick: load, style: { padding: '4px 10px' } }, t('refresh')),
            )
            : values.pets.map((pet, index) => {
              const draft = drafts[pet.id] || { enabled: false, commentStyle: '' };
              const acp = pet.provider === 'acp';
              const hidden = pet.display === 'none';
              const acpLocked = acp && activeAcpId !== '' && activeAcpId !== pet.id;
              const locked = acpLocked;
              return h('div', {
                key: pet.id,
                style: {
                  border: '1px solid rgba(127,127,127,0.25)',
                  borderRadius: 6,
                  padding: '10px 12px',
                  marginBottom: 12,
                  opacity: locked ? 0.6 : 1,
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
                  h('div', { style: { fontWeight: 600 } }, `${index + 1}. ${pet.name} / ${pet.id}`),
                  h('span', {
                    style: {
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 999,
                      color: '#fff',
                      background: acp ? '#4a6cf7' : '#2f9e44',
                    },
                  }, acp ? 'ACP' : 'API'),
                ),
                h('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, t('persona')),
                h('div', {
                  style: {
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 90,
                    overflow: 'auto',
                    background: 'rgba(127,127,127,0.08)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    marginBottom: 8,
                  },
                }, pet.persona || t('personaEmpty')),
                h('div', { style: { fontSize: 13, marginBottom: 4 } }, t('style')),
                h('textarea', {
                  value: draft.commentStyle || '',
                  placeholder: DEFAULT_STYLE,
                  rows: 3,
                  onChange: e => updatePet(pet.id, { commentStyle: e.target.value }),
                  style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical' },
                  disabled: locked,
                }),
                h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, t('styleHint')),
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8 } },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.enabled === true,
                    disabled: locked,
                    onChange: e => togglePet(pet, e.target.checked),
                  }),
                  h('span', null, t('enabled')),
                ),
                hidden ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, t('displayNone'))
                  : acpLocked ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, t('acpLocked')) : null,
              );
            }),
        ),

        h(Row, { title: t('sessionReset'), hint: t('sessionResetHint') },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'checkbox',
                checked: values.sessionResetEnabled === true,
                onChange: e => updateValue({ sessionResetEnabled: e.target.checked }),
              }),
              h('span', null, values.sessionResetEnabled === true ? '开启' : '关闭'),
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { opacity: 0.75, fontSize: 13 } }, t('sessionResetThreshold')),
              h('select', {
                value: String(values.sessionResetThreshold || 200000),
                disabled: values.sessionResetEnabled !== true,
                onChange: e => updateValue({ sessionResetThreshold: Number(e.target.value) }),
                style: { padding: '4px 8px' },
              }, [['64k', 65536], ['128k', 131072], ['200k', 200000], ['256k', 262144], ['300k', 300000]].map(([label, n]) =>
                h('option', { key: n, value: String(n) }, `${label} tokens`)
              )),
            ),
            h('button', {
              onClick: clearAcp,
              disabled: clearing,
              style: { padding: '4px 10px' },
            }, clearing ? t('clearing') : t('clearAcp')),
          ),
          h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 6 } }, t('clearAcpHint')),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', {
            onClick: saveAll,
            disabled: state === t('saving'),
            style: { padding: '6px 18px', fontWeight: 600 },
          }, t('save')),
          h('span', { style: { fontSize: 12, opacity: 0.7 } }, state),
        ),

        h('p', { style: { opacity: 0.65, fontSize: 12, marginTop: 16 } }, t('restart')),
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
