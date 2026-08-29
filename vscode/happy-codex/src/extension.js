'use strict';

const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

const {
  createWrapper,
  deriveProxyExecutable,
  isManagedWrapper,
  resolveExecutablePath,
  resolveBundledCodexPath
} = require('./bridgeConfig');

const PREVIOUS_CLI_KEY = 'happyCodex.previousChatgptCliExecutable';
const ENABLED_KEY = 'happyCodex.enabled';

function execFileAsync(command, args, timeout = 15_000, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: false,
      env: { ...process.env, ...envOverrides }
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureHappyDaemon(happyExecutable, output, codexExecutable) {
  await execFileAsync(
    happyExecutable,
    ['daemon', 'start'],
    15_000,
    codexExecutable ? { HAPPY_CODEX_PATH: codexExecutable } : {}
  );
  output.info('Happy daemon is running for full Codex catalog sync.');
}

async function checkHappy(happyExecutable) {
  const state = await happyAuthState(happyExecutable);
  if (state.kind !== 'authenticated') {
    throw new Error(state.detail);
  }
}

async function happyAuthState(happyExecutable) {
  try {
    const result = await execFileAsync(happyExecutable, ['auth', 'status']);
    const authenticated = /Authenticated/.test(result.stdout)
      && !/Not authenticated/.test(result.stdout);
    return authenticated
      ? { kind: 'authenticated', label: '已登录', detail: 'Happy CLI 已认证，可以同步 Codex session。' }
      : { kind: 'unauthenticated', label: '未登录', detail: '点击“登录 Happy”在 VS Code 终端完成认证。' };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        kind: 'missing',
        label: '未安装 CLI',
        detail: `找不到 Happy CLI：${happyExecutable}`
      };
    }
    return {
      kind: 'error',
      label: '状态检查失败',
      detail: `Happy CLI check failed: ${String(error && error.message || error)}`
    };
  }
}

async function checkProxyExecutable(proxyExecutable) {
  try {
    await execFileAsync(proxyExecutable, ['--probe']);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Happy VS Code proxy not found: ${proxyExecutable}. Update or locally reinstall happy-cli.`);
    }
    throw new Error(`Happy VS Code proxy check failed: ${String(error && error.message || error)}`);
  }
}

function bridgeState(context) {
  const configured = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable');
  return {
    configured,
    enabled: isManagedWrapper(configured, context.globalStorageUri.fsPath)
  };
}

async function enable(context, output) {
  const official = vscode.extensions.getExtension('openai.chatgpt');
  if (!official) {
    throw new Error('Install the official Codex extension (openai.chatgpt) first.');
  }

  const happyExecutable = String(
    vscode.workspace.getConfiguration('happyCodex').get('happyExecutable', 'happy')
  ).trim() || 'happy';
  await checkHappy(happyExecutable);
  const proxyExecutable = deriveProxyExecutable(happyExecutable);
  await checkProxyExecutable(proxyExecutable);

  const codexExecutable = resolveBundledCodexPath(official.extensionPath);
  const wrapper = createWrapper(context.globalStorageUri.fsPath, proxyExecutable, codexExecutable);
  const chatgptConfig = vscode.workspace.getConfiguration('chatgpt');
  const inspected = chatgptConfig.inspect('cliExecutable');
  const currentGlobal = inspected ? inspected.globalValue : undefined;

  if (!isManagedWrapper(currentGlobal, context.globalStorageUri.fsPath)) {
    await context.globalState.update(PREVIOUS_CLI_KEY, {
      existed: currentGlobal !== undefined,
      value: currentGlobal
    });
  }

  await chatgptConfig.update('cliExecutable', wrapper, vscode.ConfigurationTarget.Global);
  await context.globalState.update(ENABLED_KEY, true);
  await ensureHappyDaemon(happyExecutable, output, codexExecutable);
  output.info(`Bridge enabled. Codex executable: ${codexExecutable}`);
  output.info(`Happy proxy wrapper: ${wrapper}`);
  await promptReload('Happy Codex mobile control is enabled. Reload VS Code to reconnect Codex through Happy.');
}

async function disable(context, output) {
  const chatgptConfig = vscode.workspace.getConfiguration('chatgpt');
  const previous = context.globalState.get(PREVIOUS_CLI_KEY);
  if (previous && previous.existed) {
    await chatgptConfig.update('cliExecutable', previous.value, vscode.ConfigurationTarget.Global);
  } else {
    await chatgptConfig.update('cliExecutable', undefined, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update(PREVIOUS_CLI_KEY, undefined);
  await context.globalState.update(ENABLED_KEY, false);
  output.info('Bridge disabled and previous chatgpt.cliExecutable restored.');
  await promptReload('Happy Codex mobile control is disabled. Reload VS Code to restore the direct Codex connection.');
}

async function promptReload(message) {
  const selected = await vscode.window.showInformationMessage(message, 'Reload Now');
  if (selected === 'Reload Now') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function showStatus(context) {
  const state = bridgeState(context);
  const detail = state.enabled
    ? `Enabled. Proxy: ${state.configured}`
    : 'Disabled. Run “Happy Codex: Enable Mobile Control” to connect VS Code Codex to Happy.';
  await vscode.window.showInformationMessage(`Happy Codex: ${detail}`);
}

async function openCodex() {
  const official = vscode.extensions.getExtension('openai.chatgpt');
  if (!official) {
    throw new Error('Install the official Codex extension (openai.chatgpt) first.');
  }
  await official.activate();
  await vscode.commands.executeCommand('chatgpt.openSidebar');
}

function configuredHappyExecutable() {
  return String(
    vscode.workspace.getConfiguration('happyCodex').get('happyExecutable', 'happy')
  ).trim() || 'happy';
}

function login(context, output) {
  const executable = resolveExecutablePath(configuredHappyExecutable());
  const terminal = vscode.window.createTerminal({
    name: 'Happy Login',
    shellPath: executable,
    shellArgs: ['auth', 'login'],
    iconPath: new vscode.ThemeIcon('account')
  });
  context.subscriptions.push(terminal);
  terminal.show();
  output.info(`Opened Happy login terminal with ${executable}.`);
  void vscode.window.showInformationMessage('请在 Happy Login 终端完成登录，然后回到 Happy 侧边栏刷新状态。');
}

function sidebarHtml(webview) {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { padding: 18px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    h2 { margin: 0 0 6px; font-size: 17px; }
    .intro { margin: 0 0 20px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .card { padding: 14px; margin-bottom: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .status { font-weight: 600; }
    .status.good { color: var(--vscode-testing-iconPassed); }
    .status.warn { color: var(--vscode-notificationsWarningIcon-foreground); }
    .detail { min-height: 38px; margin: 10px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .actions { display: grid; gap: 8px; margin-top: 16px; }
    button { width: 100%; padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 3px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: .5; }
    .privacy { margin-top: 16px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
  </style>
</head>
<body>
  <h2>Happy Codex</h2>
  <p class="intro">从手机查看并控制本机全部 CLI / VS Code Codex session。</p>
  <section class="card">
    <div class="row"><span class="label">Happy 账户</span><span id="auth" class="status">检查中…</span></div>
    <p id="auth-detail" class="detail">正在读取 Happy CLI 登录状态。</p>
  </section>
  <section class="card">
    <div class="row"><span class="label">手机控制</span><span id="bridge" class="status">检查中…</span></div>
    <p id="bridge-detail" class="detail">正在读取 Codex bridge 状态。</p>
  </section>
  <div class="actions">
    <button id="login" data-action="login">登录 Happy</button>
    <button id="enable" data-action="enable">启用手机控制</button>
    <button id="disable" class="secondary" data-action="disable">停用手机控制</button>
    <button class="secondary" data-action="openCodex">打开 Codex</button>
    <button class="secondary" data-action="refresh">刷新状态</button>
  </div>
  <p class="privacy">登录在 VS Code 集成终端中完成。Happy 凭据和加密数据不会进入这个面板。</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const auth = document.getElementById('auth');
    const authDetail = document.getElementById('auth-detail');
    const bridge = document.getElementById('bridge');
    const bridgeDetail = document.getElementById('bridge-detail');
    const login = document.getElementById('login');
    const enable = document.getElementById('enable');
    const disable = document.getElementById('disable');

    function setBusy(busy) {
      document.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    }

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        setBusy(true);
        vscode.postMessage({ type: 'action', action: button.dataset.action });
      });
    });

    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'state') return;
      const state = data.state;
      const authenticated = state.auth.kind === 'authenticated';
      auth.textContent = state.auth.label;
      auth.className = 'status ' + (authenticated ? 'good' : 'warn');
      authDetail.textContent = state.auth.detail;
      bridge.textContent = state.bridge.enabled ? '已启用' : '未启用';
      bridge.className = 'status ' + (state.bridge.enabled ? 'good' : 'warn');
      bridgeDetail.textContent = state.bridge.enabled
        ? '重新加载 VS Code 后，Codex session 会同步到 Happy 手机端。'
        : '登录后启用，将官方 Codex session 接入 Happy。';
      login.hidden = authenticated;
      setBusy(false);
      enable.disabled = !authenticated || state.bridge.enabled;
      disable.disabled = !state.bridge.enabled;
    });

    vscode.postMessage({ type: 'refresh' });
    setInterval(() => {
      if (document.visibilityState === 'visible') vscode.postMessage({ type: 'refresh' });
    }, 5000);
  </script>
</body>
</html>`;
}

class HappyControlViewProvider {
  constructor(context, getState) {
    this.context = context;
    this.getState = getState;
    this.view = undefined;
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sidebarHtml(view.webview);
    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'refresh') {
          await this.refresh();
          return;
        }
        const commands = {
          login: 'happyCodex.login',
          enable: 'happyCodex.enable',
          disable: 'happyCodex.disable',
          openCodex: 'happyCodex.openCodex',
          refresh: 'happyCodex.refresh'
        };
        const command = commands[message.action];
        if (message.type === 'action' && command) await vscode.commands.executeCommand(command);
        await this.refresh();
      })
    );
    await this.refresh();
  }

  async refresh() {
    if (!this.view) return;
    const state = await this.getState();
    await this.view.webview.postMessage({ type: 'state', state });
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Happy Codex', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'happyCodex.status';
  let controlView;

  const refreshStatus = () => {
    const state = bridgeState(context);
    status.text = state.enabled ? '$(broadcast) Happy Codex' : '$(debug-disconnect) Happy Codex';
    status.tooltip = state.enabled ? 'Codex sessions sync to Happy' : 'Happy Codex bridge disabled';
    status.show();
  };

  const run = (action) => async () => {
    try {
      await action();
      refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.error(message);
      void vscode.window.showErrorMessage(`Happy Codex: ${message}`);
    } finally {
      await controlView.refresh();
    }
  };

  controlView = new HappyControlViewProvider(context, async () => ({
    auth: await happyAuthState(configuredHappyExecutable()),
    bridge: bridgeState(context)
  }));

  context.subscriptions.push(
    output,
    status,
    vscode.window.registerWebviewViewProvider('happyCodex.controlCenter', controlView),
    vscode.commands.registerCommand('happyCodex.login', run(() => login(context, output))),
    vscode.commands.registerCommand('happyCodex.enable', run(() => enable(context, output))),
    vscode.commands.registerCommand('happyCodex.disable', run(() => disable(context, output))),
    vscode.commands.registerCommand('happyCodex.status', run(() => showStatus(context))),
    vscode.commands.registerCommand('happyCodex.openCodex', run(openCodex)),
    vscode.commands.registerCommand('happyCodex.refresh', run(async () => {})),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('chatgpt.cliExecutable')
        || event.affectsConfiguration('happyCodex.happyExecutable')) {
        refreshStatus();
        void controlView.refresh();
      }
    })
  );

  refreshStatus();
  if (bridgeState(context).enabled) {
    const happyExecutable = configuredHappyExecutable();
    void happyAuthState(happyExecutable).then((auth) => {
      if (auth.kind !== 'authenticated') return;
      return ensureHappyDaemon(happyExecutable, output);
    }).catch((error) => {
      output.warn(`Could not auto-start Happy daemon: ${String(error && error.message || error)}`);
    });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
