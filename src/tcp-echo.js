#!/usr/bin/node --harmony
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const net = require('node:net');

const argv = yargs(hideBin(process.argv))
    .version('1.0.0')
    .option('p', {
        alias: 'port',
        describe: 'tcp port to listen',
        demandOption: true,
        type: 'number',
        nargs: 1,
    })
    .help()
    .alias('help', 'h')
    .argv;

const server = net.createServer(c => {
    const clientIdent = socket => {
        var ip = socket.remoteAddress;
        if (! ip.search('::ffff:'))
            ip = ip.slice('::ffff:'.length);
        return `${ip}:${c.remotePort}`;
    };
    console.log(`client connected: ${clientIdent(c)}`);

    c.on('end', () => {
        console.log(`client disconnected: ${clientIdent(c)}`);
    });
    c.on('data', data => {
        console.log(`< ${clientIdent(c)}: len ${data.length}`);
        console.log(data.toString());
        c.write(data, err => {
            if (err)
                console.error(`error when writing to ${clientIdent(c)}:`, err.message);
            else
                console.log(`> ${clientIdent(c)}: len ${data.length}`);
        });
    })
    c.on('error', err => {
        console.error(`error from ${clientIdent(c)}:`
            , err.code ? err.code : err.message);
    });
});
server.on('error', err => {
    console.error(err.message);
    process.exit(1);
});
server.listen(+argv.port, () => {
    console.log(`listen on port ${+argv.port}`);
});
