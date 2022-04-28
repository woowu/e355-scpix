#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');
const { LoremIpsum } = require('lorem-ipsum');

const scpi = {
    readDeviceId: '*IDN?',
    readModemPowerGoodPin: 'DIGital:PIN? P52',
    readModemDccPin: 'DIGital:PIN? P51',
    assertModemDcc: 'DIGital:PIN P51,HI',
    deassertModemDcc: 'DIGital:PIN P51,LO',
    turnOnModemPowerKey: 'DIGital:PIN PD1,LO,500',
    turnOffModemPowerKey: 'DIGital:PIN PD1,LO,1000',
    enableSciLoopback: 'WAN:LOOPback:STOp',
    disableSciLoopback: 'WAN:LOOPback:STArt',
    optoForwardingOn: 'SER:CON ON',
    optoForwardingOff: '+++',
    rebootDevice: 'PWRState:MONVolt 1600',
};

const defaultAtRespDelay = 1000;
const defaultScpiRespDelay = 800;
const slowScpiRespDelay = 2000;
const fastScpiRespDelay = 50;

/**
 * Thirdparty: Box Muller transform.
 */
const randBoxMuller = (min, max, skew) => {
    let u = 0, v = 0;
    while(u === 0) u = Math.random() //Converting [0,1) to (0,1)
    while(v === 0) v = Math.random()
    let num = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v )

    num = num / 10.0 + 0.5 // Translate to 0 -> 1
    if (num > 1 || num < 0) 
        num = randn_bm(min, max, skew) // resample between 0 and 1 if out of range

    else{
        num = Math.pow(num, skew) // Skew
        num *= max - min // Stretch to fill range
        num += min // offset to min
    }
    return num
}; 

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
    };
};

const runScpi = (context, command, onResponse, timeout, cb) => {
    if (typeof timeout == 'function') {
        cb = timeout;
        timeout = defaultScpiRespDelay;
    }

    var timer;
    var onData;

    const end = (err, data) => {
        if (timer) clearTimeout(timer);
        context.device.removeListener('data', onData);
        cb(err, data);
    };
    onData = makeRespHandler(response => {
        onResponse(response, end);
    });
    context.device.on('data', onData);
    context.lineSender(command, () => {
        timer = setTimeout(() => {
            end(new Error(`${command} timeout`), null);
        }, timeout); 
    });
};

const makeAtEnvironment = (lineSender, execCb, onClose) => {
    const forwardingModeDelay = 2000;

    lineSender(scpi.optoForwardingOn, () => {
        setTimeout(() => {
            /* when execution inside the execCb ends, the 2nd argument,
             * which is a onExecEnd callback must be called.
             */
            execCb(null, err => {
                lineSender(scpi.optoForwardingOff, () => {
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
    console.log('send data.', 'len', text.length);
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
        context.lineSender(scpi.readDeviceId);
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
        context.device.removeListener('data', onData);
        cb(null);
    };

    process.stdin.setRawMode(true);
    process.stdin.once('data', onInterrupt);
    context.device.on('data', onData);
    probe();
};

const commandModemPower = (context, cb) => {
    const dccWait = 100;
    const powerKeyWait = 1500;
    const powerWait = 2000;

    const powerOffLevel = '0';
    const powerOnLevel = '1';
    const dccOffLevel = '0';
    const dccOnLevel = '1';

    const powerOn = cb => {
        runScpi(context, scpi.readModemPowerGoodPin, (response, cb) => {
            cb(null, response);
        }, (err, response) => {
            if (err) return cb(err);
            if (response == powerOffLevel) {
                console.log('modem is off');
                runScpi(context, scpi.assertModemDcc, (response, cb) => {
                }, dccWait, err => {
                    runScpi(context, scpi.turnOnModemPowerKey, (response, cb) => {
                    }, powerKeyWait, err => {
                        setTimeout(() => {
                            runScpi(context, scpi.readModemPowerGoodPin, (response, cb) => {
                                console.log('modem power is', response == powerOffLevel
                                    ? 'off' : response == powerOnLevel ? 'on' : 'unknown');
                                cb(null);
                            }, powerWait, cb);
                        });
                    });
                });
                return;
            }
            if (response == powerOnLevel) {
                console.log('modem is on');
                return cb(null);
            }
            return cb(new Error('modem power state unknown'));
        });
        return;
    };

    const powerOff = cb => {
        runScpi(context, scpi.turnOffModemPowerKey, (response, cb) => {
        }, powerKeyWait, err => {
            runScpi(context, scpi.deassertModemDcc, (response, cb) => {
            }, dccWait, err => {
                cb(null);
            });
        });
    };

    const powerStatus = cb => {
        runScpi(context, scpi.readModemPowerGoodPin, (response, cb) => {
            console.log('modem', response == powerOnLevel
                ? 'is on' : response == powerOffLevel ? 'is off'
                : 'power state unknown');
            cb(null);
        }, err => {
            if (err) return cb(err);
            runScpi(context, scpi.readModemDccPin, (response, cb) => {
                console.log('Dcc', response == dccOnLevel
                    ? 'asserted' : response == dccOffLevel ? 'deasserted'
                    : 'state unkonwn');
                cb(null);
            }, cb);
        });
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

    if (status == 'on') {
        context.lineSender(scpi.optoForwardingOn, () => {
            cb(null);
        });
        return;
    }
    if (status == 'off') {
        context.lineSender(scpi.optoForwardingOff, () => {
            cb(null);
        });
        return;
    }
    console.error('Bad argument');
};

const commandSciLoopback = (context, cb) => { 
    const status = context.argv.status;
    if (! status)
        return cb(new Error('on or off needed'));

    if (status == 'on') {
        context.lineSender(scpi.enableSciLoopback, () => {
            cb(null);
        });
        return;
    }
    if (status == 'off') {
        context.lineSender(scpi.disableSciLoopback, () => {
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
        context.device.removeListener('data', onData);
        cb(null);
    });
    timer = setTimeout(() => {
        context.device.removeListener('data', onData);
        cb(null);
    }, 2000);
    context.device.on('data', onData);
    context.lineSender(line, { raw: context.argv.raw })
};

const commandSendAt = (context, cb) => {
    const argv = context.argv;
    var rs;
    if (argv.file) {
        rs = fs.createReadStream(argv.file);
        rs.on('error', cb);
    } else
        rs = process.stdin;
    const rl = require('readline').createInterface({
        input: rs,
    });

    const specs = [];
    rl.on('line', line => {
        if (line.trim() == '') return;
        const tokens = line.split(',');
        const spec = {
            command: tokens[0].trim(),
            timeout: tokens[1] !== undefined ? +tokens[1] : defaultAtRespDelay,
            expect: tokens[2] !== undefined ? tokens[2].trim() : ['OK', 'ERROR'],
        };
        specs.push(spec);
    });
    rl.on('close', () => {
        makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
            const execSpec = specs => {
                if (! specs.length) return onExecEnd(null);
                context.atSender(specs.shift(), () => {
                    execSpec(specs);
                });
            };
            execSpec(specs);
        }, cb);
    });
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

const commandRebootDevice = (context, cb) => {
    var timer;

    const onData = makeRespHandler(response => {
        console.log('<', response);
        context.device.removeListener('data', onData);
        if (timer) clearTimeout(timer);
        cb(null);
    });
    timer = setTimeout(() => {
        context.device.removeListener('data', onData);
        cb(new Error('timeout'));
    }, defaultScpiRespDelay);
    context.device.on('data', onData);
    context.lineSender(scpi.rebootDevice);
};

/**
 * Since NB85 meter firmware on, the modem Rx/Tx PINs will be set as GPIOs
 * almost immediately after meter is powered up, in this state the AT
 * traffics to the modem cannot through. To solve this difficulty, I send
 * a SCPI command to turn the PINs back to UART mode just after they were
 * set as GPIOs and before the modem power-up sequence will be starting.
 * If I issue the SCPI command too earlier, the firmware's settings of
 * turning the PINs GPIO will come after me and overwrite my settings; If
 * I do it too later, the modem power-up sequence will start before my
 * setting, and the start-up sequence will be facing with GPIO pins, that
 * will cause the AT failure at its earlier stage, that in turn will fool
 * the firmware to make it change UART's baud to the next one. Once the
 * UART's baudrate was changed to a wrong one, there is no a SCPI command
 * can change it back until the next power cycle.
 *
 * After the above described operations, the alogrithm will start a AT
 * command to test whether the modem is up working, if not success,
 * the whole operation will repeat with randomly adjusted timing until
 * success.
 */
const commandUnlockNb85 = (context, cb) => {
    const fromRebootOkToEnableLoopBack = 2900; /* my measure: 2.878s */
    const fromEnableLoopbackToModemSetBaud = 3100; /* my measure: 3.142s */
    const skew = 1.5;
    const modemWaitSecs = 5;
    const maxRepeats = 5;
    const retryDelay = 1000;
    const successMessage = 'succeeded. modem UART has been unlocked';
    const modemWaitMessage = `waiting ${modemWaitSecs} seconds`
        + ' for modem power up';

    const retry = repeatCount => {
        const atTest = cb => {
            makeAtEnvironment(context.lineSender, (err, onExecEnd) => {
                context.atSender({
                    command: 'at',
                    timeout: defaultAtRespDelay,
                    expect: 'OK',
                }, onExecEnd); 
            }, cb);
        };
        const linkTest = (count, cb) => {
            runScpi(context, scpi.readDeviceId, (response, cb) => {
                if (response.length) console.log('<', response);
                cb(response.search('LANDIS') < 0
                    ? new Error(
                        'scpi link seems not working')
                    : null);
            }, err => {
                if (err) {
                    if (((count + 1) % 5) == 0)
                        console.error('please check your cable'
                            + ' or possibly power cycle the deivce');
                    setTimeout(() => {
                        linkTest(count + 1, cb);
                    }, 200);
                    return;
                }
                cb(null);
            });
        };
        const sendReboot = cb => {
            runScpi(context, scpi.rebootDevice, (response, cb) => {
                if (response.length) console.log('<', response);
                cb(response.search('OK') < 0
                    ? new Error(
                        'rebooting device failed')
                    : null);
            }, cb);
        };
        const disableLoopback = cb => {
            runScpi(context, scpi.disableSciLoopback, (response, cb) => {
                if (response.length) console.log('<', response);
                cb(response.search('OK') < 0
                    ? new Error(
                        'disable loopback failed')
                    : null);
            }, cb);
        };
        const scheduleRetry = () => {
            if (maxRepeats > 0 && repeatCount + 1 == maxRepeats)
                return cb(new Error('reached max repeat count'
                    + `(${repeatCount + 1})`));
            setTimeout(() => {
                retry(repeatCount + 1)
            }, retryDelay);
        };

        const timeToDisableLoopback = randBoxMuller(fromRebootOkToEnableLoopBack - 200
            , (fromRebootOkToEnableLoopBack + fromEnableLoopbackToModemSetBaud) + 200
            , skew);

        linkTest(0, err => {
            if (err) return cb(err);
            sendReboot(err => {
                if (err) {
                    console.error(err.message);
                    scheduleRetry();
                    return;
                }
                console.log('use delay'
                    + ` ${(timeToDisableLoopback/1000).toFixed(3)} secs`);
                setTimeout(() => {
                    disableLoopback(err => {
                        if (err) {
                            console.error(err.message);
                            scheduleRetry();
                            return
                        }
                        console.log(modemWaitMessage);
                        setTimeout(() => {
                            atTest(err => {
                                if (err) {
                                    console.error(err.message);
                                    scheduleRetry();
                                    return;
                                }
                                console.log(successMessage);
                                cb(null);
                            });
                        }, modemWaitSecs * 1000);
                    });
                }, timeToDisableLoopback);
            });
        });
    };
    retry(0);
};

const argv = yargs(hideBin(process.argv))
    .version('0.1.0')
    .option('d', {
        alias: 'device',
        describe: 'serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('b', {
        alias: 'baud',
        describe: 'serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 9600,
    })
    .option('u', {
        alias: 'mtu',
        describe: 'maximum send/receive size of socket data',
        nargs: 1,
        type: 'number',
        default: 1200,
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
            .option('t', {
                alias: 'network',
                describe: 'network type: CatM or NBIoT',
                nargs: 1,
                type: 'string',
                default: 'NBIoT',
            })
            .option('a', {
                alias: 'apn',
                describe: 'Network access point name (APN)',
                nargs: 1,
                type: 'string',
                default: '',
            })
            .option('u', {
                alias: 'username',
                describe: 'username',
                nargs: 1,
                type: 'string',
                default: '',
            })
            .option('p', {
                alias: 'password',
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
            .option('c', {
                alias: 'context-id',
                describe: 'PDP context ID',
                nargs: 1,
                type: 'number',
                default: 1,
            });
    }, makeCommandHandler(commandActivatePDP))
    .command('tcp-open', 'Open the TCP conn', yargs => {
        yargs
            .option('a', {
                alias: 'address',
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
            .option('n', {
                alias: 'len',
                describe: 'length of data to send',
                nargs: 1,
                type: 'number',
                demandOption: true,
            })
    }, makeCommandHandler(commandTcpSend))
    .command('tcp-recv', 'Receive data from TCP', yargs => {
    }, makeCommandHandler(commandTcpRecv))
    .command('device-reboot', 'Reboot the device', yargs => {
    }, makeCommandHandler(commandRebootDevice))
    .command('unlock-nb85', 'Unlock NB85 modem UART', yargs => {
    }, makeCommandHandler(commandUnlockNb85))
    .command('sci-loopback <status>', 'Turn on/off loopback of SCI pins', yargs => {
        yargs
            .positional('status', {
                type: 'string',
                describe: 'on or off',
                });
    }, makeCommandHandler(commandSciLoopback))
    .command('send <line>', 'Send single line to the deivce', yargs => {
        yargs
            .positional('line', {
                type: 'string',
                describe: 'text line to send',
                })
            .option('r', {
                alias: 'raw',
                describe: 'Send raw data, no \r\n will be added to the end',
                type: 'boolean',
                default: false,
            });
    }, makeCommandHandler(commandSend))
    .command('at', 'Send AT commands to the modem', yargs => {
        yargs
            .option('f', {
                alias: 'file',
                describe: 'A file contains AT commands of "<CMD>[,timeout,expect]".'
                    + ' When this option is not present, read commands from stdin.',
                type: 'string',
            });
    }, makeCommandHandler(commandSendAt))
    .command('forward <status>', 'Turn on/off forwarding between modem and optical head', yargs => {
        yargs
            .positional('status', {
                type: 'string',
                describe: 'on or off',
                });
    }, makeCommandHandler(commandForward))
    .help()
    .alias('help', 'h')
    .argv;

