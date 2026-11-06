import { launchdPlist, SERVICE_LABEL, systemdUnit } from '../../../src/cli/commands/supervise.js';

describe('supervise service definitions', () => {
  const command = ['/opt/node bin/node', '/Users/me/My Apps/mcpc/dist/cli/index.js', 'supervise'];

  it('renders a launchd agent that keeps mcpc supervise alive', () => {
    const plist = launchdPlist(command, '/Users/me/.mcpc', '/Users/me/.mcpc/logs/supervise.log');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/node bin/node</string>');
    expect(plist).toContain('<string>supervise</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>MCPC_HOME_DIR</key>\n    <string>/Users/me/.mcpc</string>');
  });

  it('escapes XML in paths', () => {
    expect(launchdPlist(['/a&b/<n>'], '/h', '/l')).toContain('<string>/a&amp;b/&lt;n&gt;</string>');
  });

  it('renders a systemd user unit with quoted arguments', () => {
    const unit = systemdUnit(command, '/home/me/.mcpc');
    expect(unit).toContain(
      'ExecStart="/opt/node bin/node" "/Users/me/My Apps/mcpc/dist/cli/index.js" "supervise"'
    );
    expect(unit).toContain('Environment="MCPC_HOME_DIR=/home/me/.mcpc"');
    expect(unit).toContain('Restart=always');
  });
});
