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
      pauseOnFocusHint: '开启后，当 DSH 主窗口处于系统前台时自动暂停抓屏与听音，焦点离开后恢复（桌宠窗口不算）。仅 Windows 生效。',
      restart: '改动需重启 DSH 后生效。',
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
        fetch(`${API}/status`)
          .then(r => r.json())
          .then(j => {
            if (!alive) return;
            if (j && j.ok) setValues({ listenEnabled: j.listenEnabled, pauseOnFocus: j.pauseOnFocus });
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
              setValues({ listenEnabled: j.listenEnabled, pauseOnFocus: j.pauseOnFocus });
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
          ),
        h('p', { style: { opacity: 0.65, fontSize: 12, marginTop: 16 } },
          `${state ? state + ' · ' : ''}${t('restart')}`),
      );
    }

    function apply(ctx) {
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
