#!/usr/bin/node --harmony
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const net = require('node:net');

const argv = yargs(hideBin(process.argv))
    .version('0.1.0')
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
    console.log(`client connected: ${c.remoteAddress}:${c.remotePort}`);
    c.on('end', () => {
        console.log(`client disconnected: ${c.remoteAddress}:${c.remotePort}`);
    });
    c.on('data', data => {
        console.log(`< ${c.remoteAddress}:${c.remotePort}:`, data.toString());
        c.write(data, err => {
            if (err)
                console.error(`error when writing to ${c.remoteAddress}:${c.remotePort}:`, err.message);
            else
                console.log(`> ${c.remoteAddress}:${c.remotePort}:`, data.toString());
        });
    });
});
server.on('error', err => {
    console.error(err.message);
    process.exit(1);
});
server.listen(+argv.port, () => {
    console.log(`listen on port ${+argv.port}`);
});
