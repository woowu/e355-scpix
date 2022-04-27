#!/usr/bin/node --harmony
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');
const { LoremIpsum } = require('lorem-ipsum');

const makeCommandHandler = handler => {
    return argv => {
        const device = new SerialPort({
            path: argv.device,
            baudRate: argv.baud,
            autoOpen: false,
        });
        const makeLineSender = () => {
            return (line, options, cb) => {
                if (typeof options == 'function' || options === undefined ) {
                    cb = options;
                    options = { raw: false };
                }
                console.log('>', line);
                if (! options.raw) line = line + '\r\n';
                device.write(line);
                device.drain(err => {
                    ! cb || cb(err);
                });
            };
        };
        const makeAtSender = () => {
            return ({command, timeout, expect}, options, cb) => {
                if (typeof options == 'function' || options === undefined ) {
                    cb = options;
                    options = { raw: false };
                }
                var timer;
                var response = '';
                var foundExpected = false;

                if (! expect)
                    expect = [];
                else if (typeof expect == 'string')
                    expect = [expect];

                const endReceiving = () => {
                    device.removeListener('data', onData);
                    const r = response.trim().replace(/\r\n/g, '\n');
                    console.log('<', r, foundExpected ? '*' : '');
                    cb(! expect.length || foundExpected ? null : new Error('AT failed'), response);
                };
                const searchExpect = () => {
                    if (! expect.length) return false;

                    var i;
                    for (i = 0; i < expect.length && response.search(expect[i]) < 0; ++i);
                    return i < expect.length;
                };
                const onData = data => {
                    response += data.toString();
                    if (searchExpect()) {
                        foundExpected = true;
                        clearTimeout(timer);
                        endReceiving();
                    }
                };

                timer = setTimeout(endReceiving, timeout);
                device.on('data', onData);
                makeLineSender()(command, options);
            };
        };

        const context = {
            argv,
            device,
            lineSender: makeLineSender(),
            atSender: makeAtSender(),
        };
        device.open(err => {
            if (err) {
                console.error(`Error opening ${argv.device}:`, err.message);
                process.exit();
            }
            handler(context, err => {
                if (err) {
                    console.error(err.message);
                    process.exit(1);
                }
                process.exit(0);
            });
        });
    };
};

const makeRespHandler = handler => {
    var response = '';
    return serialData => {
        response += serialData.toString();
        if (response[response.length - 1] != '\n'
            || response.length < 3)
            return;
        handler(response.trim());
        response = '';
    };
};

const makeAtEnvironment = (lineSender, execCb, onClose) => {
    const scpiTurnOnForwarding = 'SER:CON ON';
    const scpiTurnOffForwarding = '+++';
    const forwardingModeDelay = 2000;

    lineSender(scpiTurnOnForwarding, () => {
        setTimeout(() => {
            /* when execution inside the execCb ends, the 2nd argument,
             * which is a onExecEnd callback must be called.
             */
            execCb(null, err => {
                lineSender(scpiTurnOffForwarding, () => {
                    setTimeout(() => {
                        onClose(err);
                    }, forwardingModeDelay);
                });
            });
        }, forwardingModeDelay);
    });
};

const atScriptRunner = (script, context, cb) => {
    const interCommandDelay = 200;
    const defaultAtRespDelay = 500;

    if (! Array.isArray(script)) script = [script];

    const exec = cb => {
        if (! script.length) return cb(null);

        const e = script.shift();
        var spec;
        if (typeof e == 'string')
            spec = { command: e, timeout: defaultAtRespDelay, expect: null };
        else
            spec = { command: e[0], timeout: e[1], expect: e[2] ? e[2] : null };
        context.atSender(spec, err => {
            if (err) return cb(err);
            setTimeout(() => {
                exec(cb);
            }, interCommandDelay);
        });
    };

    makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
        exec(onExecEnd);
    }, cb);
};

const tcpOpen = (context, ip, port, cb) => {
    const connDelay = 30000;
    context.atSender({
        command: `at+qiopen=1,0,"TCP","${ip}",${port},0,0`,
        timeout: connDelay,
        expect: 'OK\r\n',
    }, (err, resp) => {
        cb(err);
    });
};

const tcpClose = (context, cb) => {
    const closeDelay = 10500;
    context.atSender({
        command: 'at+qiclose=0',
        timeout: closeDelay,
        expect: ['OK\r\n', 'MODEM TIMEOUT'],
    }, (err, resp) => {
        cb(err);
    });
};

const tcpSend = (context, text, cb) => {
    const sendTimeout = 10000;
    context.atSender({
        command: `at+qisend=0,${text.length}`,
        timeout: 2000,
        expect: '> \r\n',
    }, (err, resp) => {
        context.atSender({
            command: text,
            timeout: sendTimeout,
            expect: 'SEND OK\r\n',
        }, { raw: ! context.argv.optical }, (err, resp) => {
            cb(err);
        });
    });
};

const tcpRecv = (context, cb) => {
    const recvTimeout = 1000;
    context.atSender({
        command: `at+qird=0,${context.argv.mtu}`,
        timeout: recvTimeout,
        expect: 'OK\r\n',
    }, (err, resp) => {
        if (err) return cb(err);
        const m = resp.match(/\+QIRD: (.*)\r\n/);
        if (! m) return cb(new Error('socket read error:', resp));
        const offset = m.index + m[0].length;
        const data = resp.slice(offset, offset + parseInt(m[1]));
        cb(null, data);
    });
};

const commandTest = (context, cb) => {
    var timer;

    const probe = () => {
        timer = setTimeout(probe, 1000);
        context.lineSender('*IDN?');
    };
    const onData = makeRespHandler(response => {
        if (timer) clearTimeout(timer);
        console.log('<', response);
        timer = setTimeout(() => {
            probe();
        }, 1000);
    });
    const onInterrupt = () => {
        process.stdin.setRawMode(false);
        context.device.removeListener('data', onData);
        if (timer) clearTimeout(timer);
        cb(null);
    };

    process.stdin.setRawMode(true);
    process.stdin.once('data', onInterrupt);
    context.device.on('data', onData);
    probe();
};

const commandModemPower = (context, cb) => {
    const readPowerGoodPin = 'DIGital:PIN? P52';
    const readDccPin = 'DIGital:PIN? P51';
    const assertDcc = 'DIGital:PIN P51,HI';
    const deassertDcc = 'DIGital:PIN P51,LO';
    const turnOnPowerKey = 'DIGital:PIN PD1,LO,500';
    const turnOffPowerKey = 'DIGital:PIN PD1,LO,1000';
    const powerOffLevel = '0';
    const powerOnLevel = '1';
    const dccOffLevel = '0';
    const dccOnLevel = '1';

    const powerOn = cb => {
        var state = 'query';

        const onData = makeRespHandler(response => {
            const dccDelay = 1000;
            const queryDelay = 2000;

            if (state != 'query') return;
            console.log('<', response);

            if (response == powerOffLevel) {
                console.log('modem is off');
                state = 'setting';
                context.lineSender(assertDcc, err => {
                    setTimeout(() => {
                        context.lineSender(turnOnPowerKey);
                        setTimeout(() => {
                            state = 'query';
                            context.lineSender(readPowerGoodPin);
                        }, queryDelay);
                    }, dccDelay);
                });
                return;
            }
            if (response == powerOnLevel) {
                console.log('modem is on');
                cb(null);
                return;
            }
        });
        context.device.on('data', onData);
        context.lineSender(readPowerGoodPin);
    };

    const powerOff = cb => {
        const interCommandDelay = 1000;
        context.lineSender(turnOffPowerKey, err => {
            setTimeout(() => {
                context.lineSender(deassertDcc, err => {
                    cb(null);
                });
            }, interCommandDelay);
        });
    };

    const powerStatus = cb => {
        const execTimeout = 3000;
        var state;
        var timer;
        const onData = makeRespHandler(response => {
            console.log('<', response);
            if (state == 'readPowerGood') {
                console.log('modem is', response == powerOffLevel ? 'off' : 'on');

                state = 'readDcc';
                context.lineSender(readDccPin);
                return;
            }
            if (state == 'readDcc') {
                console.log('Modem DCC is', response == dccOffLevel ? 'off' : 'on');
                if (timer) clearTimeout(timer);
                cb(null);
                return;
            }
        });
        context.device.on('data', onData);
        state = 'readPowerGood';
        timer = setTimeout(() => {
            cb(new Error('timeout'));
        }, execTimeout);
        context.lineSender(readPowerGoodPin);
    };

    const cmd = context.argv.subcommand;
    if (cmd == 'status')
        return powerStatus(cb);
    if (cmd == 'off')
        return powerOff(cb);
    if (cmd == 'on')
        return powerOn(cb);
    console.error('unrecognized power command:', cmd);
};

const commandForward = (context, cb) => {
    if (! context.argv.optical) return cb(new Error('not available'));

    const status = context.argv.status;
    if (! status)
        return cb(new Error('on or off needed'));

    if (status.toLowerCase() == 'on') {
        context.lineSender('SER:CON ON', () => {
            cb(null);
        });
        return;
    }
    if (status.toLowerCase() == 'off') {
        context.lineSender('+++', () => {
            cb(null);
        });
        return;
    }
    console.error('Bad argument');
};

const commandSend = (context, cb) => {
    var timer;
    const line = context.argv.line;
    if (! line) return cb(new Error('missed line'));

    const onData = makeRespHandler(response => {
        if (timer) clearTimeout(timer);
        console.log('<', response);
        cb(null);
    });
    timer = setTimeout(() => {
        context.device.removeListener('data', onData);
        cb(null);
    }, 2000);
    context.device.on('data', onData);
    context.lineSender(line, { raw: context.argv.raw })
};

const commandConfigModem = (context, cb) => {
    const atExecDelay = 1000;

    const network = context.argv.network.toUpperCase() == 'CATM'
        ? 0 : context.argv.network.toUpperCase() == 'NBIOT' ? 1 : -1;
    if (network < 0)
        return cb(new Error('Invalid network type'));

    const init = [
        'ate0',
        'at+cmee=1',
        'at+cfun=1',
        /* pin26: input, supcap type */
        'at+qcfg="gpio",1,26,0,0,0,0',
        /* pin85: output, set antenna type = ext */
        'at+qcfg="gpio",1,85,1,0,0,0',
        'at+qcfg="gpio",3,85,1,1',
        /* pin64-pin66: charge level setup pins */
        'at+qcfg="gpio",1,64,0,0,0',
        'at+qcfg="gpio",3,64,0,0',
        'at+qcfg="gpio",1,65,0,0,0',
        'at+qcfg="gpio",3,65,0,0',
        'at+qcfg="gpio",1,66,0,0,0',
        'at+qcfg="gpio",3,66,0,0',
        /* bands mask */
        'at+qcfg="band",0,8000004,0,1',
        'at+qcfg="band",0,0,95,1',
        /* automaic operator selection */
        'at+cops=0',
        /* IoT mode */
        `at+qcfg="iotopmode",${network}`,

        `at+qicsgp=1,1,"${context.argv.apn}","${context.argv.username}","${context.argv.password}",0`,
    ];

    const confSleepMode = cb => {
        context.atSender({
            command: 'at+qcfg="gpio",2,26',
            timeout: atExecDelay,
        }, (err, resp) => {
            const prefix = '"gpio",';
            var i = resp.search(prefix);
            if (i < 0)
                return cb(new Error('supcap indication gpio is not working'));
            var type = parseInt(resp[i + prefix.length]);
            console.log('module', type == 1 ? 'with' : 'without', 'supcap');
            const sclk = type == 1 ? '1' : '0';
            context.atSender({
                command: `at+qsclk=${sclk}`,
                timeout: atExecDelay,
            }, (err, resp) => {
                if (! type) {
                    context.atSender({
                        command: 'at+qcfg="fast/poweroff",25,1',
                        timeout: atExecDelay,
                    }, (err, resp) => {
                        cb(err);
                    });
                } else
                    cb(err);
            });
        });
    };

    atScriptRunner(init, context, err => {
        if (err) return cb(err);
        makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
            confSleepMode(onExecEnd);
        }, cb);
    });
};

const commandModemInfo = (context, cb) => {
    const query = [
        'at+cimi',
        'at+cgmi',
        'at+cgmm',
        'at+cgmr',
        'at+cgsn',
        'at+cpin?',
        'at+csq',
        'at+cereg?',
        [ 'at+qiact?', 2500, 'OK\r\n' ],
    ];
    atScriptRunner(query, context, cb);
};

const commandActivatePDP = (context, cb) => {
    var cid = context.argv.c;
    const script = [
        [ `at+qiclose=0,3`, 2000, 'OK\r\n' ],
        [ `at+qideact=${cid}`, 1000 ],
        [ `at+qiact=${cid}`, 1000 ],
        [ `at+qiact?`, 1000 ],
    ];
    atScriptRunner(script, context, cb);
};

const commandTcpOpen = (context, cb) => {
    var [ip, port] = context.argv.address.split(':');
    if (! ip || ! port) return cb(new Error('bad address'));

    makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
        tcpOpen(context, ip, +port, onExecEnd);
    }, cb);
};

const commandTcpClose = (context, cb) => {
    makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
        tcpClose(context, onExecEnd);
    }, cb);
};

const commandTcpSend = (context, cb) => {
    const len = context.argv.len;
    const mtu = context.argv.mtu;

    const lorem = new LoremIpsum({
        sentencesPerParagraph: {
            max: 100,
            min: 100,
        },
        wordsPerSentence: {
            max: 50,
            min: 5,
        },
    });

    makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
        const send = (len, cb) => {
            const thisLen = len < mtu ? len : mtu;
            if (thisLen <= 0) return cb(null);

            var text = '';
            while (text.length < thisLen)
                text += lorem.generateSentences().slice(0, thisLen - text.length);

            tcpSend(context, text, err => {
                if (err) return cb(err);
                send(len - thisLen, cb);
            });
        };
        send(len, onExecEnd);
    }, cb);
};

const commandTcpRecv = (context, cb) => {
    const mtu = context.argv.mtu;

    var received = '';
    makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
        const recv = (soFar, cb) => {
            tcpRecv(context, (err, data) => {
                if (err || ! data) return cb(err, soFar);
                recv(soFar + data, cb);
            });
        };
        recv('', (err, data) => {
            received = data;
            onExecEnd(err);
        });
    }, err => {
        console.log(received);
        cb(err);
    });
};

const argv = yargs(hideBin(process.argv))
    .version('0.1.0')
    .option('device', {
        alias: 'd',
        describe: 'serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('baud', {
        alias: 'b',
        describe: 'serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 9600,
    })
    .option('mtu', {
        alias: 'u',
        describe: 'maximum send/receive size of socket data',
        nargs: 1,
        type: 'number',
        default: 1024,
    })
    .option('optical', {
        describe: 'is using optical head',
        type: 'boolean',
        default: true,
    })
    .command('test', 'Test scpi connectivity', yargs => {
    }, makeCommandHandler(commandTest))
    .command('modem-power <subcommand>', 'Turn on/off modem or query its power status', yargs => {
        yargs
            .positional('subcommand', {
                type: 'string',
                describe: 'status|on|off',
                })
    }, makeCommandHandler(commandModemPower))
    .command('modem-conf', 'Configure modem', yargs => {
        yargs
            .option('network', {
                alias: 'n',
                describe: 'network type: CatM or NBIoT',
                nargs: 1,
                type: 'string',
                default: 'NBIoT',
            })
            .option('apn', {
                alias: 'a',
                describe: 'Network access point name (APN)',
                nargs: 1,
                type: 'string',
                default: '',
            })
            .option('username', {
                alias: 'u',
                describe: 'username',
                nargs: 1,
                type: 'string',
                default: '',
            })
            .option('password', {
                alias: 'p',
                describe: 'password',
                nargs: 1,
                type: 'string',
                default: '',
            });
    }, makeCommandHandler(commandConfigModem))
    .command('modem-info', 'Modem information, including network registration status', yargs => {
    }, makeCommandHandler(commandModemInfo))
    .command('pdp-activate', 'Activate PDP context. Do it only after network registered', yargs => {
        yargs
            .option('context-id', {
                alias: 'c',
                describe: 'PDP context ID',
                nargs: 1,
                type: 'number',
                default: 1,
            });
    }, makeCommandHandler(commandActivatePDP))
    .command('tcp-open', 'Open the TCP conn', yargs => {
        yargs
            .option('address', {
                alias: 'a',
                describe: 'destination address <IP>:<PORT>',
                nargs: 1,
                type: 'string',
                demandOption: true,
            })
    }, makeCommandHandler(commandTcpOpen))
    .command('tcp-close', 'Close the TCP conn', yargs => {
    }, makeCommandHandler(commandTcpClose))
    .command('tcp-send', 'Send data over TCP', yargs => {
        yargs
            .option('len', {
                alias: 'n',
                describe: 'length of data to send',
                nargs: 1,
                type: 'number',
                demandOption: true,
            })
    }, makeCommandHandler(commandTcpSend))
    .command('tcp-recv', 'Receive data from TCP', yargs => {
    }, makeCommandHandler(commandTcpRecv))
    .command('forward <status>', 'Turn on/off forwarding between modem and optical head', yargs => {
        yargs
            .positional('status', {
                type: 'string',
                describe: 'on or off',
                });
    }, makeCommandHandler(commandForward))
    .command('send <line>', 'Send single line to the deivce', yargs => {
        yargs
            .positional('line', {
                type: 'string',
                describe: 'text line to send',
                })
            .option('raw', {
                alias: 'r',
                describe: 'send raw data, no \r\n will be added to the end',
                type: 'boolean',
                default: false,
            });
    }, makeCommandHandler(commandSend))
    .help()
    .alias('help', 'h')
    .argv;

