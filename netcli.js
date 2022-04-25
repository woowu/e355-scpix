#!/usr/bin/node --harmony
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');

const makeCommandHandler = handler => {
    return argv => {
        const device = new SerialPort({
            path: argv.device,
            baudRate: argv.baud,
            autoOpen: false,
        })
        const makeScpiSender = () => {
            return (cmdline, cb) => {
                device.flush(() => {
                    console.log('>', cmdline);
                    device.write(cmdline + '\r\n', err => {
                        ! cb || cb(err);
                    });
                });
            };
        };
        device.open(err => {
            if (err) {
                console.error(`Error opening ${argv.device}:`, err.message);
                process.exit();
            }
            handler(argv, device, makeScpiSender());
        });
    };
};

const makeRespHandler = handler => {
    var response = '';
    return serialData => {
        response += serialData.toString();
        if (response[response.length - 1] != '\n') return;
        handler(response.trim());
        response = '';
    };
};

const commandConnect = (argv, device, scpiSender) => {
    var stop;
    var timer;

    const probe = () => {
        timer = setTimeout(probe, 1000);
        scpiSender('*IDN?');
    };
    const onInterrupt = () => {
        process.stdin.setRawMode(false);
        stop = true;
    };
    const onData = makeRespHandler(response => {
        clearTimeout(timer);
        console.log('<', response);
        setTimeout(() => {
            if (stop) {
                device.removeListener('data', onData);
                process.exit(0);
            }
            probe();
        }, 1000);
    });

    process.stdin.setRawMode(true);
    process.stdin.once('data', onInterrupt);
    device.on('data', onData);
    probe();
};

const commandPowerOn = (argv, device, scpiSender) => {
    const readPowerGoodPin = 'DIGital:PIN? P52';
    const assertDcc = 'DIGital:PIN P51,HI';
    const turnOnPowerKey = 'DIGital:PIN PD1,LO,500';
    const powerOff = '0';
    const powerOn = '1';
    var state = 'query';

    const onData = makeRespHandler(response => {
        if (state != 'query') return;
        console.log('<', response);

        if (response == powerOff) {
            state = 'setting';
            scpiSender(assertDcc);
            setTimeout(() => {
                scpiSender(turnOnPowerKey);
                setTimeout(() => {
                    state = 'query';
                    scpiSender(readPowerGoodPin);
                }, 1000);
            }, 200);
            return;
        }
        if (response == powerOn) {
            device.removeListener('data', onData);
            console.log('modem turned on');
            process.exit(0);
        }
        setTimeout(() => {
            scpiSender(readPowerGoodPin);
        }, 200);
    });
    device.on('data', onData);
    scpiSender(readPowerGoodPin);
};

const commandPowerOff = (argv, device, scpiSender) => {
    const turnOffPowerKey = 'DIGital:PIN PD1,LO,1000';
    const deassertDcc = 'DIGital:PIN P51,LO';

    scpiSender(turnOffPowerKey);
    setTimeout(() => {
        scpiSender(deassertDcc, () => {
            process.exit(0);
        });
    }, 500);
};

const commandForward = (argv, device, scpiSender) => {
    const cmd = argv._[1];
    if (cmd == 'on') {
        scpiSender('SER:CON ON', () => {
            process.exit(0);
        });
        return;
    }
    if (cmd == 'off') {
        scpiSender('+++', () => {
            process.exit(0);
        });
        return;
    }
    console.error('Bad argument');
};

const commandExec = (argv, device, scpiSender) => {
    const cmd = argv._[1];
    scpiSender(argv._[1], () => {
        process.exit(0);
    })
};

const commandInitModem = (argv, device, scpiSender) => {
    const atList = [
        "ate0",
        "at+cimi",
        "at+cgmi",
        "at+cgmm",
        "at+cgmr",
        "at+cgsn",
        "at+qcfg=\"iotopmode\",1",
        "at+cfun=1",
        "at+cpin?",
        "AT+QCFG=\"gpio\",1,85,1,0,0,1",
        "AT+QCFG=\"gpio\",3,85,1,1",
        "at+cops=0",
        "at+qcfg=\"band\",0,8000004,0,1",
        "at+qcfg=\"band\",0,0,95,1",
        "at+qicsgp=1,1,\"CMNBIOT\",\"\",\"\",0",
        "at+cereg?",
        "at+cereg?",
        "at+cereg?",
        "at+qicsgp=1,1,\"UNINET\",\"\",\"\",1",
        "AT+QIOPEN=1,0,\"TCP\",\"116.6.51.98\",9005,0,1",
        "at+qisend=0,10",   /* after the > prompt, input 10 chars, it will be auto sent out */
    ];
    const execAt = (i, cb) => {
        if (i == atList.length) {
            cb(null);
            return;
        };
        var response = '';
        function onData(data) {
            response += data.toString();
        };
        const at = atList[i];
        device.removeListener('data', onData);
        device.on('data', onData);
        setTimeout(() => {
            console.log('<', response.trim());
            execAt(i + 1, cb);
        }, 500);
        scpiSender(at);
    };
    scpiSender('SER:CON ON', () => {
        setTimeout(() => {
            execAt(0, () => {
                setTimeout(() => {
                    //scpiSender('+++', () => {
                        process.exit(0);
                    //});
                }, 500);
            });
        }, 500);
    });
};

const argv = yargs(hideBin(process.argv))
    .option('device', {
        alias: 'd',
        describe: 'usb device name',
        demandOption: true,
        nargs: 1,
    })
    .option('baud', {
        alias: 'b',
        describe: 'optical head baudrate',
        nargs: 1,
        type: 'number',
        default: 9600,
    })
    .command('connect', 'test line connection', yargs => {
    }, makeCommandHandler(commandConnect))
    .command('poweron-modem', 'turn on modem', yargs => {
    }, makeCommandHandler(commandPowerOn))
    .command('poweroff-modem', 'turn off modem', yargs => {
    }, makeCommandHandler(commandPowerOff))
    .command('forward', 'turn on/off forwarding', yargs => {
    }, makeCommandHandler(commandForward))
    .command('exec', 'execute single scpi command', yargs => {
    }, makeCommandHandler(commandExec))
    .command('initmodem', 'initial modem', yargs => {
    }, makeCommandHandler(commandInitModem))
    .help()
    .alias('help', 'h')
    .argv;

