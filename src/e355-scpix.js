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
    readModemPowerUpFlags: 'MODEm:POWUp:Status?',
    deassertModemDcc: 'DIGital:PIN P51,LO',
    turnOnModemPowerKey: 'DIGital:PIN PD1,LO,650',
    turnOffModemPowerKey: 'DIGital:PIN PD1,LO,1000',
    enableSciLoopback: 'WAN:LOOPback:STOp',
    disableSciLoopback: 'WAN:LOOPback:STArt',
    optoForwardingOn: 'SER:CON ON',
    optoForwardingOff: '+++',
    rebootDevice: 'PWRState:MONVolt 1600',
    setForwardingTimeout: 'SERial:TIMEout 8000',
};

/* The Quectel modem allow the max size of sending and receiving of 1460/1500
 * octets. But the bottlenecks are the sizes of buffers that meter forwarding
 * task used for receiving and sending.
 *
 * For receiving from the forwarding task, i.e., PC sending, the buffers chain
 * is: UART rx buffer (240 bytes) --> task rx buffer (1024 bytes), hence the PC
 * can send up to 240 + 1024 - 2 (for \r\n) = 1262 bytes in one shot, that
 * defined the TX MTU in this tool.
 *
 * For sending from the forwarding task, i.e., PC receiving,  the data needs to
 * be fully hold in the tx buffer of the forwarding task before it can send them
 * to the PC. And, when talking about large size sending from the forwarding
 * task, that always means it's TCP/UDP data triggered by executing of +qird
 * command, this type of data has the form of:
 * +QIRD:\x20<nnn>\r\n<DATA>\r\nOK\r\n. That means there are 14 octets of
 * overhead. The max size of the enclosed TCP/UDP data is therefore up to 1024 -
 * 18 = 1006 byte, which defined our RX MTU in this tool.
 *
 * We just pick up the minimum of TX MTU and RX MTU, that is 1014 as our max MTU
 * size.
 */
const maxMtu = 1006;
const maxTimeout = 2**31 - 1;
const realTiming = {
    atRespDelay: 1000,
    scpiRespDelay: 800,
    tcpConnDelay: 10000,
    tcpCloseDelay: 10500,
    tcpSendTimeout: 10000,
    tcpRecvTimeout: 1000,
    tcpPingDataWaitTimeout: 15000,
};
const forSimulatingTiming = {
    atRespDelay: 3000/*maxTimeout*/,
    scpiRespDelay: maxTimeout,
    tcpConnDelay: maxTimeout,
    tcpCloseDelay: maxTimeout,
    tcpSendTimeout: maxTimeout,
    tcpRecvTimeout: maxTimeout,
    tcpPingDataWaitTimeout: maxTimeout,
};

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

const generateText = len => {
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
    var text = '';
    while (text.length < len)
        text += lorem.generateSentences().slice(0, len - text.length);
    return text;
};

const makeCommandHandler = handler => {
    const interCharTimeout = 20;

    return argv => {
        if (argv.mtu < 1 || argv.mtu > maxMtu) {
            console.error('invalid mtu:', argv.mtu);
            return;
        }
        if (! isNaN(+argv.atDelay))
            realTiming.atRespDelay = +argv.atDelay;

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

        /**
         * Create closure of function atSender(atSpec, timeout, cb):
         *      atSpect <Object> {command, timeout, expect}
         *      options <Object>
         *      cb      <Function> (err)
         */
        const makeAtSender = () => {
            const scpiTimeoutStr = '\r\nMODEM TIMEOUT\r\n';
            var lastRecvTime;

            return ({command, timeout, expect}, options, cb) => {
                if (typeof options == 'function' || options === undefined ) {
                    cb = options;
                    options = { raw: false };
                }
                var response = '';

                if (! expect)
                    expect = [];
                else if (typeof expect == 'string')
                    expect = [expect];

                const searchExpect = () => {
                    if (! expect.length) return false;

                    var i;
                    for (i = 0; i < expect.length && response.search(expect[i]) < 0; ++i);
                    return i < expect.length;
                };
                const endReceiving = found => {
                    device.removeListener('data', onData);
                    const r = response.trim().replace(/\r\n/g, '\n');
                    console.log('<', r, found ? '*' : '');
                    cb(! expect.length || found ? null : new Error('AT failed'), response);
                };
                const onInterCharTimeout = () => {
                    if (response.search(scpiTimeoutStr) >= 0) {
                        /* I received the special string scpiTimeoutStr, that
                         * means the modem has yet to response, and we still
                         * want to wait for it, but the scpi server has reached
                         * its timeout time (2s). After the timeout, the scpi
                         * server's turned to me, this is wrong, I need to fool
                         * it to turn back to the modem by sending it some
                         * non-sense things with what she expected line ending.
                         * But there is a catch, whatever I send to her will be
                         * forwarded to the modem, hope this is fine.
                         */
                        response = response.split(scpiTimeoutStr).join('');
                        console.log(`[${scpiTimeoutStr.trim()}]`);
                        device.write(' \r\n');
                    }
                    if (searchExpect()) {
                        endReceiving(true);
                        return;
                    }
                    if ((new Date() - lastRecvTime) >= timeout)
                        return endReceiving(false);
                    setTimeout(onInterCharTimeout, interCharTimeout);
                };
                const onData = data => {
                    if (argv.verbose) console.log('<', data);
                    lastRecvTime = new Date();
                    response += data.toString();
                };

                setTimeout(onInterCharTimeout, interCharTimeout);
                device.on('data', onData);
                lastRecvTime = new Date();
                makeLineSender()(command, options);
            };
        };

        const context = {
            argv,
            device,
            lineSender: makeLineSender(),
            atSender: makeAtSender(),
            timing: argv.simulate ? forSimulatingTiming : realTiming,
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

const makeScpiResponseHandler = (handler, printRaw) => {
    var response = '';
    return serialData => {
        if (printRaw) console.log('<', serialData);
        response += serialData.toString();
        if (response[response.length - 1] != '\n')
            return;
        handler(response.trim());
        response = '';
    };
};

const fileReducer = (context, file, resultSet, lineHandler, resultsHandler) => {
    var rs;
    if (file != '-') {
        rs = fs.createReadStream(argv.file);
        rs.on('error', err => {
            console.error(err.message);
            resultsHandler(resultSet);
        });
    } else
        rs = process.stdin;
    const rl = require('readline').createInterface({
        input: rs,
    });

    const specs = [];
    rl.on('line', line => {
        if (line.trim() == '') return;
        lineHandler(line, result => {
            resultSet.push(result);
        });
    });
    rl.on('close', () => {
        resultsHandler(resultSet);
    });
};

const makeTimeoutFixer = () => {
    var fixed = false;

    return (context, cb) => {
        if (fixed) return cb(null);
        runScpi(context, scpi.setForwardingTimeout, (response, cb) => {
            if (response) console.log('<', response);
            cb(null);
        }, err => {
            fixed = true;
            cb(null);
        });
    };
};
const timeoutFixer = makeTimeoutFixer();

/**
 * Assume it's already in AT environment.
 */
const querySupercapType = (context, cb) => {
    context.atSender({
        command: 'at+qcfg="gpio",2,26',
        timeout: context.timing.atRespDelay,
    }, (err, resp) => {
        if (err) return cb(err);
        const prefix = '"gpio",';
        var i = resp.search(prefix);
        if (i < 0)
            return cb(new Error('supercap indication gpio is not working'));
        var type = parseInt(resp[i + prefix.length]);
        if (type != 1 && type != 0)
            return cb(new Error('unknown supercap type: ' + type));
        cb(null, type);
    });
};

const readPin = (context, pin, cb) => {
    const prefix = 'DIGital:PIN';
    runScpi(context, `${prefix}? ${pin}`, (response, cb) => {
        cb(null, parseInt(response));
    }, cb);
};

const setPin = (context, pin, value, cb) => {
    const prefix = 'DIGital:PIN';
    if (value !== 0 && value !== 1)
        return cb(new Error('bad argument'));
    runScpi(context, `${prefix} ${pin},${value === 0 ? 'LO' : 'HI'}`, (response, cb) => {
        cb(null);
    }, cb);
};

const runScpi = (context, command, onResponse, timeout, cb) => {
    if (typeof timeout == 'function') {
        cb = timeout;
        timeout = context.timing.scpiRespDelay;
    }

    var timer;
    var onData;

    const end = (err, data) => {
        if (timer) clearTimeout(timer);
        context.device.removeListener('data', onData);
        cb(err, data);
    };
    onData = makeScpiResponseHandler(response => {
        onResponse(response, end);
    }, argv.verbose);
    context.device.on('data', onData);
    context.lineSender(command, () => {
        timer = setTimeout(() => {
            end(new Error(`${command} timeout`), null);
        }, timeout); 
    });
};

const makeAtEnvironment = (context, execCb, onClose) => {
    const forwardCommandDelay = 1500;

    runScpi(context, scpi.optoForwardingOn, (response, cb) => {
        cb(response.search('ERROR') >= 0
            ? new Error('BUSY: cannot start forwarding')
            : null);
    }, err => {
        /* Some version of firmware does not send response back for the SER:CON,
         * hence the timeout is not an error. In firmware versions which will
         * response, it will send ERROR when error.
         */
        if (err && err.message.search('timeout') < 0) return onClose(err);
        setTimeout(() => {
            execCb(null, err => {
                context.lineSender(scpi.optoForwardingOff, () => {
                    setTimeout(() => {
                        onClose(err);
                    }, 200);
                });
            });
        }, forwardCommandDelay);
    });
};

const atScriptRunner = (script, context, alreadyInAt, cb) => {
    if (typeof alreadyInAt == 'function') {
        cb = alreadyInAt;
        alreadyInAt = false;
    }
    const interCommandDelay = 200;

    if (! Array.isArray(script)) script = [script];

    const exec = cb => {
        if (! script.length) return cb(null);

        const e = script.shift();
        var spec;
        if (typeof e == 'string')
            spec = { command: e, timeout: context.timing.atRespDelay, expect: null };
        else
            spec = { command: e[0], timeout: e[1], expect: e[2] ? e[2] : null };
        context.atSender(spec, err => {
            if (err) return cb(err);
            setTimeout(() => {
                exec(cb);
            }, interCommandDelay);
        });
    };

    if (alreadyInAt) return exec(cb);
    makeAtEnvironment(context, (err, onExecEnd) => {
        exec(onExecEnd);
    }, cb);
};

const renewPDP = (context, cid, connId, apn, user, password, cb) => {
    const script = [
        [`at+qiclose=${connId},3`
           , context.timing.tcpCloseDelay, 'OK\r\n'],
        [`at+qideact=${cid}`
           , 2 * context.timing.atRespDelay, 'OK\r\n'],
        [`at+qicsgp=1,1,"${apn}","${user}","${password}",0`
           , context.timing.atRespDelay, 'OK\r\n'],
        [`at+qiact=${cid}`
           , 3 * context.timing.atRespDelay, 'OK\r\n'],
        [`at+qiact?`
            , 2 * context.timing.atRespDelay, 'OK\r\n'],
    ];
    atScriptRunner(script, context, cb);
};

const tcpOpen = (context, ip, port, cb) => {
    context.atSender({
        command: `at+qiopen=1,0,"TCP","${ip}",${port},0,0`,
        timeout: context.timing.tcpConnDelay,
        expect: 'OK\r\n',
    }, (err, resp) => {
        cb(err);
    });
};

const tcpClose = (context, cb) => {
    context.atSender({
        command: 'at+qiclose=0',
        timeout: context.timing.tcpCloseDelay,
        expect: ['OK\r\n', 'MODEM TIMEOUT'],
    }, (err, resp) => {
        /* the modem quit often returns nothing when doing +qiclose, so I
         * discard the error.
         */
        cb(null);
    });
};

const tcpSend = (context, connId, text, cb) => {
    console.log('send data.', 'len', text.length);
    context.atSender({
        command: `at+qisend=${connId},${text.length}`,
        timeout: context.timing.atRespDelay,
        expect: [
            '> \r\n',
            'PROMPT\r\n', 'PROMPT \r\n',
            'ERROR\r\n', 'ERROR \r\n',
            'OVERFLOW\r\n', 'OVERFLOW \r\n',
        ],
    }, (err, resp) => {
        if (err) return cb(err);
        if (resp.search('ERROR') >= 0 || resp.search('OVERFLOW') >= 0)
            return cb(new Error('modem error: ' + resp.trim()));
        context.atSender({
            command: text,
            timeout: context.timing.tcpSendTimeout,
            expect: 'SEND OK\r\n',
        }, { raw: ! context.argv.optical }, (err, resp) => {
            cb(err);
        });
    });
};

const tcpSendBig = (context, connId, text, mtu, cb) => {
    const waitAck = (repeatCnt, cb) => {
        const queryDelay = 500;

        if (repeatCnt > 30) return cb(new Error('no ack for a long time'));

        const queryUnAckedBytes = cb => {
            context.atSender({
                command: `at+qisend=${connId},0`,
                timeout: 3 * context.timing.atRespDelay,
                expect: [
                    '\r\nOK\r\n',
                    'ERROR\r\n',
                ],
            }, (err, resp) => {
                if (err) return cb(err);
                const pos = resp.search('QISEND:');
                if (pos < 0)
                    return cb(new Error(
                        'bad response when querying ack status (01): ' + resp));
                const str = resp.split(',')[2];
                if (str === null || str === undefined)
                    return cb(new Error(
                        'bad response when querying ack status (02): ' + resp));
                const unAcked = parseInt(str);
                if (isNaN(unAcked))
                    return cb(new Error(
                        'bad response when querying ack status (03): ' + resp));
                cb(null, unAcked);
            });
        };
        setTimeout(() => {
            queryUnAckedBytes((err, unAcked) => {
                if (err) return cb(err);
                if (! unAcked) return cb(null);
                waitAck(repeatCnt + 1, cb);
            });
        }, repeatCnt ? 2 * queryDelay : queryDelay);
    };
    const send = (text, cb) => {
        if (! text.length) return cb(null);
        tcpSend(context, connId, text.slice(0, mtu), err => {
            if (err) return cb(err);
            waitAck(0, err => {
                if (err) return cb(err);
                send(text.slice(mtu), cb);
            });
        });
    };
    send(text, cb);
};

const tcpRecv = (context, cb) => {
    const head = /\+QIRD: /;
    const headLen = 7;
    const tail = '\r\nOK\r\n';
    const formatErrMessage = '+QIRD message invalid';

    context.atSender({
        command: `at+qird=0,${context.argv.mtu}`,
        timeout: context.timing.tcpRecvTimeout,
        expect: tail,
    }, (err, resp) => {
        if (err) return cb(err);
        if (resp.search(head) < 0
            || resp.slice(resp.length - tail.length) != tail)
            return cb(new Error(formatErrMessage))

        var data = resp.slice(resp.search(head) + headLen
            , resp.length - tail.length);
        var len = 0;
        while (data.length) {
            if (! (data[0] >= '0' && data[0] <= '9'))
                break;
            len = len * 10 + (data[0] - '0');
            data = data.slice(1);
        }
        if (data.slice(0, 2) != '\r\n')
            return cb(new Error(formatErrMessage))
        data = data.slice(2)
        if (data.length < len)
            return cb(new Error(formatErrMessage))
        cb(null, data.slice(0, len));
    });
};

const commandTest = (context, cb) => {
    var timer;

    const probe = () => {
        timer = setTimeout(probe, 1000);
        context.lineSender(scpi.readDeviceId);
    };
    const onData = makeScpiResponseHandler(response => {
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
    const powerOnWait = 2500;
    const dccCreepingDelay = 1500;

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
                    setTimeout(() => {
                        runScpi(context, scpi.turnOnModemPowerKey
                            , (response, cb) => {
                            }, powerKeyWait, err => {
                                setTimeout(() => {
                                    runScpi(context, scpi.readModemPowerGoodPin
                                        , (response, cb) => {
                                            console.log('modem power is',
                                                response == powerOffLevel
                                                ? 'off'
                                                : response == powerOnLevel
                                                ? 'on'
                                                : 'unknown');
                                            cb(null);
                                        }, cb);
                            }, powerOnWait);
                        });
                    }, dccCreepingDelay);
                });
                return;
            }
            if (response == powerOnLevel) {
                console.log('modem is on');
                return cb(null);
            }
            return cb(new Error('modem power state unknown'));
        });
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
            }, err => {
                if (err) return cb(err);
                runScpi(context, scpi.readModemPowerUpFlags, (response, cb) => {
                    var n = +response;
                    console.log(`PowerKey pressed ${(n & 0xff000000) >> 24} times;`
                        + ` AT retried ${(n & 0x00ff0000) >> 16} times;`
                        + ` Error flags: 0x${(n & 0xffff).toString(16).padStart(4, '0')}`);
                    cb(null);
                }, () => {
                    readPin(context, 'P53', (err, level) => {
                        if (err) return cb(err);
                        console.log('P53 level is', level);

                        makeAtEnvironment(context, (err, onExecEnd) => {
                            if (err) return onExecEnd(err);
                            querySupercapType(context, (err, type) => {
                                if (err) return onExecEnd(err);
                                console.log((type == 1 ? 'with' : 'without') + ' supercap');

                                context.atSender({
                                    command: 'at+qsclk?',
                                    timeout: context.timing.atRespDelay,
                                    expect: 'OK\r\n',
                                }, (err, resp) => {
                                    if (err) return onExecEnd(err);
                                    if (resp.search(': 0\r\n') >= 0)
                                        console.log('sleep clock disabled');
                                    if (resp.search(': 1\r\n') >= 0)
                                        console.log('sleep clock enabled');
                                    context.atSender({
                                        command: 'at+qcfg="fast/poweroff"',
                                        timeout: context.timing.atRespDelay,
                                        expect: 'OK\r\n',
                                    }, (err, resp) => {
                                        if (resp.search(',0\r\n') >= 0)
                                            console.log('fast/poweroff disabled');
                                        if (resp.search(',1\r\n') >= 0)
                                            console.log('fast/poweroff enabled');
                                        return onExecEnd(err);
                                    });
                                });
                            });
                        }, cb);
                    });
                });
            });
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

const commandRunScpi = (context, cb) => {
    const execDelay = 50;

    fileReducer(context, argv.file ? argv.file : '-', [], (line, cb) => {
        const tokens = line.split(';');
        cb({
            command: tokens[0].trim(),
            timeout: tokens[1] !== undefined ? +tokens[1] : context.timing.atRespDelay,
        });
    }, specs => {
        const execSpec = specs => {
            if (! specs.length) return cb(null);
            const { command, timeout } = specs.shift();
            console.log('exec', command, 'timeout', timeout);
            runScpi(context, command, (response, cb) => {
                console.log(response);
                cb(null);
            }, timeout, err => {
                if (err) return cb(err);
                setTimeout(() => {
                    execSpec(specs);
                }, execDelay);
            });
        };
        execSpec(specs);
    });
};

const commandFixTimeout = (context, cb) => {
    timeoutFixer(context, cb);
};

const commandGpio = (context, cb) => {
    if (context.argv.value === undefined)
        return readPin(context, context.argv.pin, (err, level) => {
            if (err) return cb(err);
            console.log('level', level);
            return cb(null);
        });
    setPin(context, context.argv.pin, +context.argv.value, cb);
};

const commandRunAt = (context, cb) => {
    var execDelay = 500;

    if (! isNaN(+context.argv.interDelay))
        execDelay = +context.argv.interDelay;

    fileReducer(context, argv.file ? argv.file : '-', [], (line, cb) => {
        const tokens = line.split(';');
        cb({
            command: tokens[0].trim(),
            timeout: tokens[1] !== undefined && tokens[1] != ''
                ? +tokens[1] : context.timing.atRespDelay,
            expect: tokens[2] !== undefined
                ? tokens[2].trim() : ['OK\r\n', 'ERROR\r\n'],
        });
    }, specs => {
        timeoutFixer(context, err => {
            if (err) return cb(err);
            makeAtEnvironment(context, (err, onExecEnd) => {
                const execSpec = specs => {
                    if (! specs.length) return onExecEnd(null);
                    context.atSender(specs.shift(), () => {
                        setTimeout(() => {
                            execSpec(specs);
                        }, execDelay);
                    });
                };
                execSpec(specs);
            }, cb);
        });
    });
};

const commandConfigModem = (context, cb) => {
    const network = context.argv.network.toUpperCase() == 'CATM'
        ? 0 : context.argv.network.toUpperCase() == 'NBIOT' ? 1 : -1;
    const antenna = +context.argv.antenna;
    if (network < 0)
        return cb(new Error('Invalid network type'));
    if (isNaN(antenna) || antenna < 0 || antenna > 1)
        return cb(new Error('Invalid antenna type'));

    const init = [
        'ate0',
        'at+cmee=1',
        'at+cfun=1',
        /* pin26: input, supcap type */
        'at+qcfg="gpio",1,26,0,0,0,1',
        /* pin85: output, set antenna type */
        'at+qcfg="gpio",1,85,1,0,0,1',
        `at+qcfg="gpio",3,85,${antenna},1`,
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

    const confPowerControl = cb => {
        querySupercapType(context, (err, type) => {
            if (err) return cb(err);

            /* If it's with supercap, means the DTR is connected, we should use
             * the DTR as sleep mode control; otherwise, the DTR is not
             * connected, we must disable the sleep clock inside the modem to
             * prevent it from sleeping.
             * And, if it's with supercap, the fast/poweroff GPIO is not
             * connected, then we should disable the fast/poweroff feature;
             * otherwise, the fast/poweroff is connected, we should enable the
             * featgure.
             */
            const enableFastPoweroff = type != 1;
            const sclk = type == 1 ? '1' : '0';

            context.atSender({
                command: `at+qsclk=${sclk}`,
                timeout: context.timing.atRespDelay,
            }, (err, resp) => {
                context.atSender({
                    command: 'at+qcfg="fast/poweroff",25,'
                        + (enableFastPoweroff ? '1' : '0'),
                    timeout: context.timing.atRespDelay,
                }, (err, resp) => {
                    cb(err);
                });
            });
        });
    };

    timeoutFixer(context, err => {
        if (err) return cb(err);
        atScriptRunner(init, context, err => {
            if (err) return cb(err);
            makeAtEnvironment(context, (err, onExecEnd) => {
                confPowerControl(onExecEnd);
            }, cb);
        });
    });
};

const commandAntenna = (context, cb) => {
    const antenna = +context.argv.type;
    if (isNaN(antenna) || antenna < 0 || antenna > 1)
        return cb(new Error('Invalid antenna type'));

    const s = [
        /* pin85: output, set antenna type */
        'at+qcfg="gpio",1,85,1,0,0,1',
        `at+qcfg="gpio",3,85,${antenna},1`,
    ];

    timeoutFixer(context, err => {
        if (err) return cb(err);
        atScriptRunner(s, context, err => {
            if (err) return cb(err);
            makeAtEnvironment(context, (err, onExecEnd) => {
                onExecEnd(null);
            }, cb);
        });
    });
};

const commandModemInfo = (context, cb) => {
    const query = [
        'at+qsclk?',
        'at+qcfg="fast/poweroff"',
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
    renewPDP(context, context.argv.cid, 0, context.argv.apn, context.username
        , context.password, cb);
};

const commandTcpOpen = (context, cb) => {
    var [ip, port] = context.argv.address.split(':');
    if (! ip || ! port) return cb(new Error('bad address'));

    timeoutFixer(context, err => {
        if (err) return cb(err);
        makeAtEnvironment(context, (err, onExecEnd) => {
            tcpOpen(context, ip, +port, onExecEnd);
        }, cb);
    });
};

const commandTcpPing = (context, cb) => {
    const firstSendDelay = 2000;
    var [ip, port] = context.argv.address.split(':');
    if (! ip || ! port) return cb(new Error('bad address'));
    var repeats = +context.argv.n;
    if (repeats < 1) repeats = 1;
    if (repeats < 0) return cb(new Error('bad argument'));
    const size = parseInt(context.argv.size);
    if (size <= 0) return cb(new Error('bad argument'));
    const timeout = context.argv.timeout * 1000;
    if (timeout < 0) return cb(new Error('bad timeout'));
    const interMessageDelay = context.argv.delay * 1000;
    if (interMessageDelay < 0) return cb(new Error('bad delay time'));
    const mtu = context.argv.mtu <= 0 ? 1 : parseInt(context.argv.mtu);
    const cid = 1;
    const connId = 0;

    const atExec = (err, onExecEnd) => {
        const stats = {
            sentCnt: 0,
            sentBytes: 0,
            recvCnt: 0,
            recvBytes: 0,
        };
        const startTime = new Date();

        const pingNext = (cnt, cb) => {
            if (! cnt) return cb(null, cnt);
            console.log('TCP ping, remaining count', cnt);
            const sent = generateText(size);
            tcpSendBig(context, connId, sent, mtu, err => {
                const recvDelay = 200;
                ++stats.sentCnt;
                if (err) return cb(err, cnt - 1);
                stats.sentBytes += sent.length;

                var received = '';
                const recvNext = (startTime, cb) => {
                    const waitAndRecvNext = () => {
                        setTimeout(() => {
                            recvNext(startTime, cb);
                        }, recvDelay);
                    };
                    tcpRecv(context, (err, data) => {
                        if (err) return cb(err);
                        if (context.argv.verbose)
                            console.log(`received len ${data.length}`, data);
                        received += data;

                        /* As long as data is still coming, I will not
                         * stop;
                         */
                        if (data.length)
                            return waitAndRecvNext();

                        /* As long as I still have time and data is
                         * still short than what is expected, I will not
                         * stop.
                         */
                        if (received.length < sent.length
                            && new Date() - startTime
                                < context.timing.tcpPingDataWaitTimeout
                        )
                            return waitAndRecvNext();

                        ++stats.recvCnt;
                        stats.recvBytes += received.length;
                        if (received == sent) {
                            if (context.argv.verbose)
                                console.log(`recved bytes so far: ${stats.recvBytes}`);
                        } else {
                            console.log(`receiving mismatched. len ${received.length}:`);
                            console.log(received);
                        }
                        if (received == sent)
                            console.log('Ok, send/recv matched');
                        return cb(received != sent
                            ? new Error('received data mismatched')
                            : null);
                    });
                };
                recvNext(new Date(), err => {
                    if (err) return cb(err, cnt - 1);
                    setTimeout(() => {
                        pingNext(cnt - 1, cb);
                    }, interMessageDelay);
                });
            });
        };

        const startPing = () => {
            const recoverDelay = 2000;
            const reopenDelay = 2000;

            const printStatus = cb => {
                console.log('query PDP and socket status');
                const script = [
                    [ `at+qisend=${connId},0`, 2 * context.timing.atRespDelay, 'OK\r\n' ],
                    [ `at+qistate=0,${cid}`, 2 * context.timing.atRespDelay, 'OK\r\n' ],
                    [ `at+qistate=1,${connId}`, 2 * context.timing.atRespDelay, 'OK\r\n' ],
                ];
                atScriptRunner(script, context, true, cb);
            };

            const recover = cb => {
                console.log('Recover possible socket error');
                tcpClose(context, err => {
                    setTimeout(() => {
                        tcpOpen(context, ip, +port, cb);
                    }, reopenDelay);
                });
            };

            const pingUntilFail = (remainedPings, cb) => {
                pingNext(remainedPings, (err, remainedPings) => {
                    const handleRemainings = () => {
                        setTimeout(() => {
                            recover(err => {
                                if (err) return cb(err);
                                setTimeout(() => {
                                    pingUntilFail(remainedPings, cb);
                                }, firstSendDelay);
                            });
                        }, recoverDelay);
                    };

                    if (err) {
                        console.error(err.message);
                        printStatus(() => {
                            if (remainedPings)
                                handleRemainings();
                            else
                                cb(null);
                        });
                        return;
                    }
                    if (! remainedPings) return cb(null);
                    handleRemainings();
                });
            };

            pingUntilFail(repeats, err => {
                if (err) console.error(err.message);
                onExecEnd(err);
                console.log(`sent ${stats.sentCnt} messages, ttl ${stats.sentBytes} bytes`);
                console.log(`recved ${stats.recvCnt} messages, ttl ${stats.recvBytes} bytes`);
                console.log(`used ${(new Date() - startTime)/1000} secs`);
            });
        };

        tcpOpen(context, ip, +port, err => {
            if (err) return onExecEnd(err);
            setTimeout(startPing, firstSendDelay);
        });
    };

    renewPDP(context, cid, connId, context.argv.apn, context.argv.username
        , context.argv.password, err => {
            if (err) return cb(err);
            runScpi(context, scpi.setForwardingTimeout, (response, cb) => {
                if (response) console.log('<', response);
                cb(null);
            }, () => {
                makeAtEnvironment(context, atExec, cb);
            });
        }
    );
};

const commandTcpClose = (context, cb) => {
    runScpi(context, scpi.setForwardingTimeout, (response, cb) => {
        if (response) console.log('<', response);
        cb(null);
    }, () => {
        makeAtEnvironment(context, (err, onExecEnd) => {
            tcpClose(context, onExecEnd);
        }, cb);
    });
};

const commandTcpSend = (context, cb) => {
    const len = parseInt(context.argv.len);
    const mtu = context.argv.mtu <= 0 ? 1 : parseInt(context.argv.mtu);
    if (len <= 0) return cb(new Error('bad length'));

    runScpi(context, scpi.setForwardingTimeout, (response, cb) => {
        if (response) console.log('<', response);
        cb(null);
    }, () => {
        makeAtEnvironment(context, (err, onExecEnd) => {
            tcpSendBig(context, 0, generateText(len), mtu, onExecEnd);
        }, cb);
    });
};

const commandTcpRecv = (context, cb) => {
    const mtu = context.argv.mtu;

    runScpi(context, scpi.setForwardingTimeout, (response, cb) => {
        if (response) console.log('<', response);
        cb(null);
    }, () => {
        var received = '';
        makeAtEnvironment(context, (err, onExecEnd) => {
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
    });
};

const commandRebootDevice = (context, cb) => {
    var timer;

    const onData = makeScpiResponseHandler(response => {
        console.log('<', response);
        context.device.removeListener('data', onData);
        if (timer) clearTimeout(timer);
        cb(null);
    });
    timer = setTimeout(() => {
        context.device.removeListener('data', onData);
        cb(new Error('timeout'));
    }, context.timing.scpiRespDelay);
    context.device.on('data', onData);
    context.lineSender(scpi.rebootDevice);
};

/**
 * Since NB85 meter firmware on, the modem Rx/Tx PINs have been set as GPIOs
 * almost immediately after meter is powered up, in this state the AT traffics
 * to the modem cannot through. To solve this difficulty, I send a SCPI command
 * to turn the PINs back to UART mode just after they were set as GPIOs and
 * before the modem power-up sequence will be starting.  If I issue the SCPI
 * command too earlier, the firmware's settings of turning the PINs to GPIO will
 * come after me and overwrite my settings; If I do it too later, the modem
 * power-up sequence will start before my setting, and the start-up sequence
 * will be facing with GPIO pins, that will cause the AT failure at its earlier
 * stage, which in turn will fool the firmware to make it change UART's baud to
 * the next one. Once the UART's baudrate was changed to a wrong one, there is
 * no a SCPI command can change it back until the next power cycle.
 *
 * After the above described operations, the alogrithm will start a AT command
 * to test whether the modem is up working, if not success, the whole operation
 * will repeat with randomly adjusted timing until success.
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
            makeAtEnvironment(context, (err, onExecEnd) => {
                context.atSender({
                    command: 'at',
                    timeout: context.timing.atRespDelay,
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
    .version('1.1.7')
    .option('d', {
        alias: 'device',
        describe: 'Serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('b', {
        alias: 'baud',
        describe: 'Serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 9600,
    })
    .option('A', {
        alias: 'apn',
        describe: 'Network access point name (APN)',
        nargs: 1,
        type: 'string',
        default: '',
    })
    .option('U', {
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
    })
    .option('u', {
        alias: 'mtu',
        describe: 'Maximum send/receive size of socket data',
        nargs: 1,
        type: 'number',
        default: 600,
    })
    .option('optical', {
        describe: 'Use optical head',
        type: 'boolean',
        default: true,
    })
    .option('at-delay', {
        alias: 'T',
        describe: 'at response delay',
        nargs: 1,
        type: 'number',
        default: 1000,
    })
    .option('simulate', {
        alias: 'm',
        describe: 'the peer talker is a human played simulator',
        type: 'boolean',
    })
    .option('verbose', {
        describe: 'verbose mode',
        type: 'boolean',
    })
    .command('ping', 'Test scpi connectivity by sending *IDN?', yargs => {
    }, makeCommandHandler(commandTest))
    .command('modem-power <subcommand>', 'Turn on/off modem or query its power status', yargs => {
        yargs
            .positional('subcommand', {
                type: 'string',
                describe: 'status|on|off',
                })
    }, makeCommandHandler(commandModemPower))
    .command('modem-config', 'Configure modem', yargs => {
        yargs
            .option('t', {
                alias: 'network',
                describe: 'network type: CatM or NBIoT',
                nargs: 1,
                type: 'string',
                default: 'NBIoT',
            })
            .option('a', {
                alias: 'antenna',
                describe: 'antenna type. 0: internal; 1: external',
                nargs: 1,
                type: 'number',
                default: 0,
            });
    }, makeCommandHandler(commandConfigModem))
    .command('antenna <type>', 'Set antenna type', yargs => {
        yargs
            .positional('type', {
                type: 'number',
                describe: '0: internal; 1: external',
                });
    }, makeCommandHandler(commandAntenna))
    .command('modem-info', 'Modem/network information', yargs => {
    }, makeCommandHandler(commandModemInfo))
    .command('pdp-activate', 'Activate PDP context.', yargs => {
        yargs
            .option('c', {
                alias: 'context-id',
                describe: 'PDP context ID',
                nargs: 1,
                type: 'number',
                default: 1,
            });
    }, makeCommandHandler(commandActivatePDP))
    .command('tcp-ping', 'Send data to a server over TCP and wait for replies', yargs => {
        yargs
            .option('a', {
                alias: 'address',
                describe: 'desitination address in <IP>:<PORT>',
                nargs: 1,
                type: 'string',
                demandOption: true,
            })
            .option('s', {
                alias: 'size',
                describe: 'size of each data message. (will be split at MTU size)',
                nargs: 1,
                type: 'number',
                default: 64,
            })
            .option('n', {
                alias: 'times',
                describe: 'number of times to repeat',
                nargs: 1,
                type: 'number',
                default: 1,
            })
            .option('-O', {
                alias: 'timeout',
                describe: 'receiving timeout (secs)',
                nargs: 1,
                type: 'number',
                default: 8,
            })
            .option('y', {
                alias: 'delay',
                describe: 'inter message delay (secs)',
                nargs: 1,
                type: 'number',
                default: 1.5,
            })
    }, makeCommandHandler(commandTcpPing))
    .command('tcp-open', 'Open the TCP conn', yargs => {
        yargs
            .option('a', {
                alias: 'address',
                describe: 'destination address in <IP>:<PORT>',
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
                describe: 'length of data to send. (will be split at MTU size)',
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
    .command('scpi', 'Run SCPI script loaded from a file or read from stdin', yargs => {
        yargs
            .option('f', {
                alias: 'file',
                describe: 'A file contains SCPI commands of "command[;timeout]".'
                    + ' When this option is not present, read commands from stdin.',
                type: 'string',
            });
    }, makeCommandHandler(commandRunScpi))
    .command('fix-timeout', 'enlarge the too short forwarding timeout', yargs => {
    }, makeCommandHandler(commandFixTimeout))
    .command('gpio <pin> [value]', 'Read/set meter GPIO', yargs => {
        yargs
            .positional('pin', {
                type: 'string',
                describe: 'pin name',
                })
            .positional('value', {
                type: 'number',
                describe: '0 or 1',
                });
    }, makeCommandHandler(commandGpio))
    .command('at', 'Run AT script loaded from a file or read from stdin', yargs => {
        yargs
            .option('f', {
                alias: 'file',
                describe: 'A file contains AT commands of "command[;timeout;expect]".'
                    + ' When this option is not present, read commands from stdin.',
                type: 'string',
            })
            .option('--inter-delay', {
                alias: 'R',
                describe: 'delay time between execution of commands',
                type: 'number',
                default: 500,
            });
    }, makeCommandHandler(commandRunAt))
    .command('forward <status>', 'Turn on/off optical head forwarding', yargs => {
        yargs
            .positional('status', {
                type: 'string',
                describe: 'on or off',
                });
    }, makeCommandHandler(commandForward))
    .help()
    .alias('help', 'h')
    .alias('version', 'v')
    .argv;

