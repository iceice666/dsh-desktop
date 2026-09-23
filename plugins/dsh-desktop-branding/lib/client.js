window.__ModuleLoader__.load({
  id: 'dsh-desktop-branding',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Settings page: the desktop app's name and icon.
     *
     * Handwritten in the lazy-CJS shape `client-modules` serves (the same
     * wrapper tsdown emits for upstream plugins), so the page needs no build
     * step. `React.createElement` stands in for JSX; `react` and the UI
     * primitives come from the platform module table.
     *
     * Every operation goes to `/api/dsh-desktop/branding*`, served by the
     * desktop main process. Those routes accept only the desktop window's own
     * traffic, so in an ordinary browser the page reports itself unavailable.
     */

    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { Button, Input } = primitives;
    const h = React.createElement;

    const NS = 'dsh-desktop.branding';
    const API = '/api/dsh-desktop/branding';

    const zh = {
      nav: '应用外观',
      title: '应用名称与图标',
      intro: '自定义桌面应用在 Dock、菜单栏和 Cmd-Tab 中显示的名称与图标。',
      nameLabel: '应用名称',
      namePlaceholder: '留空则使用默认名称',
      save: '保存',
      saved: '已保存',
      resetName: '恢复默认名称',
      iconLabel: '应用图标',
      chooseIcon: '选择图标…',
      resetIcon: '恢复默认图标',
      iconHint: '支持 .png（建议 1024×1024 正方形）或 .icns。Dock 图标立即更新。',
      noIcon: '无图标',
      restartTitle: '需要重新启动',
      restartBody: '当前菜单栏与 Cmd-Tab 仍显示「{launched}」。重新启动后才会完全套用新的名称与图标。',
      restart: '立即重新启动',
      restarting: '正在重新启动…',
      envName: '名称由环境变量 DSH_DESKTOP_APP_NAME 指定，此处的设置在该变量存在时不会生效。',
      envIcon: '图标由环境变量 DSH_DESKTOP_ICON 指定，此处的设置在该变量存在时不会生效。',
      loading: '正在读取…',
      unavailable: '此设置仅在桌面应用中可用。',
      failed: '操作失败：{message}',
    };

    const en = {
      nav: 'Appearance',
      title: 'App name & icon',
      intro: 'Customize the name and icon the desktop app shows in the Dock, menu bar, and Cmd-Tab.',
      nameLabel: 'App name',
      namePlaceholder: 'Leave empty for the default name',
      save: 'Save',
      saved: 'Saved',
      resetName: 'Reset to default name',
      iconLabel: 'App icon',
      chooseIcon: 'Choose icon…',
      resetIcon: 'Reset to default icon',
      iconHint: 'Accepts .png (1024×1024 square recommended) or .icns. The Dock icon updates immediately.',
      noIcon: 'No icon',
      restartTitle: 'Restart required',
      restartBody: 'The menu bar and Cmd-Tab still show “{launched}”. Restart to fully apply the new name and icon.',
      restart: 'Restart now',
      restarting: 'Restarting…',
      envName: 'The name is set by the DSH_DESKTOP_APP_NAME environment variable; changes here have no effect while it is set.',
      envIcon: 'The icon is set by the DSH_DESKTOP_ICON environment variable; changes here have no effect while it is set.',
      loading: 'Loading…',
      unavailable: 'This setting is only available in the desktop app.',
      failed: 'Failed: {message}',
    };

    const css = `
.dshDesktopBranding{width:100%;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px}
.dshDesktopBranding h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dshDesktopBranding p{margin:0}
.dshDesktopBranding .intro,.dshDesktopBranding .hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshDesktopBranding .field{display:flex;flex-direction:column;gap:8px}
.dshDesktopBranding .label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dshDesktopBranding .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshDesktopBranding .row>span:first-child{flex:1 1 240px;min-width:0}
.dshDesktopBranding .icon{width:72px;height:72px;border-radius:16px;flex:none;object-fit:contain;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshDesktopBranding .notice{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.dshDesktopBranding .notice strong{font-size:14px;font-weight:500}
.dshDesktopBranding .warn{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.dshDesktopBranding .error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dshDesktopBranding .ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
`;

    /** Inject the page styles once, tagged like upstream plugin styles. */
    function installStyles() {
      const tagId = 'dsh-desktop-branding/BrandingSection.css';
      const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`;
      if (document.querySelector(selector) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-desktop-branding';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * Call one branding route.
     * @param path - route path.
     * @param body - JSON body; omitted for GET.
     * @returns the parsed JSON response.
     */
    async function call(path, body) {
      const init = body === undefined
        ? { method: 'GET', cache: 'no-store' }
        : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        };
      const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...init });
      let value;
      try {
        value = await response.json();
      } catch {
        value = {};
      }
      if (!response.ok) {
        const error = new Error(typeof value.error === 'string' ? value.error : `HTTP ${String(response.status)}`);
        error.status = response.status;
        throw error;
      }
      return value;
    }

    /**
     * The Settings page component.
     * @param props - slot props; `t` is the bound locale function.
     */
    function BrandingSection(props) {
      const t = props.t;
      const [state, setState] = React.useState(undefined);
      const [unavailable, setUnavailable] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [savedFlash, setSavedFlash] = React.useState(false);
      const [iconRevision, setIconRevision] = React.useState(0);
      const [restarting, setRestarting] = React.useState(false);

      const adopt = React.useCallback((next) => {
        setState(next);
        setDraft(next.savedName ?? '');
      }, []);

      React.useEffect(() => {
        let live = true;
        call(API).then(
          (next) => { if (live) adopt(next); },
          (cause) => {
            if (!live) return;
            // 403/404 is what an ordinary browser gets: not a failure, just
            // not the desktop window.
            if (cause.status === 403 || cause.status === 404 || cause.status === 503) setUnavailable(true);
            else setError(String(cause.message));
          },
        );
        return () => { live = false; };
      }, [adopt]);

      /** Run one mutation with shared busy/error handling. */
      const run = async (operation, after) => {
        setBusy(true);
        setError(undefined);
        try {
          const next = await operation();
          if (next !== undefined && next.name !== undefined) adopt(next);
          after?.(next);
        } catch (cause) {
          setError(String(cause.message));
        } finally {
          setBusy(false);
        }
      };

      if (unavailable) return h('div', { className: 'dshDesktopBranding' }, h('p', { className: 'intro' }, t('unavailable')));
      if (state === undefined) {
        return h('div', { className: 'dshDesktopBranding' },
          error === undefined ? h('p', { className: 'intro' }, t('loading')) : h('p', { className: 'error' }, t('failed', { message: error })));
      }

      const trimmed = draft.trim();
      const dirty = trimmed !== (state.savedName ?? '');

      const saveName = () => run(
        () => call(`${API}/name`, { name: trimmed.length === 0 ? null : trimmed }),
        () => { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500); },
      );

      const nameField = h('div', { className: 'field' },
        h('label', { className: 'label', htmlFor: 'dsh-desktop-app-name' }, t('nameLabel')),
        h('div', { className: 'row' },
          h(Input, {
            id: 'dsh-desktop-app-name',
            value: draft,
            maxLength: state.maxNameLength,
            placeholder: state.savedName === null ? state.name : t('namePlaceholder'),
            disabled: busy,
            onChange: (event) => { setDraft(event.target.value); setSavedFlash(false); },
            onKeyDown: (event) => { if (event.key === 'Enter' && dirty && !busy) void saveName(); },
          }),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || !dirty, onClick: () => void saveName() }, t('save')),
          state.savedName !== null
            ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => void run(() => call(`${API}/name`, { name: null })) }, t('resetName'))
            : null),
        savedFlash ? h('p', { className: 'ok' }, t('saved')) : null,
        state.nameSource === 'env' ? h('p', { className: 'warn' }, t('envName')) : null);

      const iconField = h('div', { className: 'field' },
        h('span', { className: 'label' }, t('iconLabel')),
        h('div', { className: 'row' },
          state.hasIcon
            ? h('img', { className: 'icon', alt: '', src: `${API}/icon?r=${String(iconRevision)}` })
            : h('div', { className: 'icon' }, t('noIcon')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: () => void run(() => call(`${API}/icon/choose`, {}), () => setIconRevision((n) => n + 1)),
          }, t('chooseIcon')),
          state.iconSource === 'preferences'
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busy,
              onClick: () => void run(() => call(`${API}/icon/reset`, {}), () => setIconRevision((n) => n + 1)),
            }, t('resetIcon'))
            : null),
        h('p', { className: 'hint' }, t('iconHint')),
        state.iconSource === 'env' ? h('p', { className: 'warn' }, t('envIcon')) : null);

      const restartNotice = state.restartRequired
        ? h('div', { className: 'notice', role: 'status' },
          h('strong', null, t('restartTitle')),
          h('p', { className: 'hint' }, t('restartBody', { launched: state.launchedName })),
          h('div', { className: 'row' },
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: busy || restarting,
              onClick: () => {
                setRestarting(true);
                call(`${API}/restart`, {}).catch((cause) => {
                  setRestarting(false);
                  setError(String(cause.message));
                });
              },
            }, restarting ? t('restarting') : t('restart'))))
        : null;

      return h('div', { className: 'dshDesktopBranding' },
        h('h2', null, t('title')),
        h('p', { className: 'intro' }, t('intro')),
        nameField,
        iconField,
        restartNotice,
        error !== undefined ? h('p', { className: 'error', role: 'alert' }, t('failed', { message: error })) : null);
    }

    /** Services the registration needs. */
    const inject = ['slots', 'locale'];

    /**
     * Register the page. Order 90 puts it after upstream's own sections.
     * @param ctx - browser Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-branding: dictionaries');
      ctx.effect(() => installStyles(), 'dsh-desktop-branding: styles');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-desktop-branding',
        order: 90,
        label: () => t('nav'),
        locale: NS,
      }, BrandingSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.BrandingSection = BrandingSection;
    return module.exports;
  },
});
