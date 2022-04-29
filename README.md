## Description
E355 SCPI Tool is a handy tool that makes it easier to access SCPI interface of PIcasso meters.

It gives you:

* commands and (grouped) options (`my-program.js serve --port=5000`).
* a dynamically generated help menu based on your arguments:

```
e355scpi [command]

Commands:
  e355scpi test                      Test scpi connectivity
  e355scpi modem-power <subcommand>  Turn on/off modem or query its power status
  e355scpi modem-conf                Configure modem
  e355scpi modem-info                Modem information, including network
                                     registration status
  e355scpi pdp-activate              Activate PDP context. Do it only after
                                     network registered
  e355scpi tcp-open                  Open the TCP conn
  e355scpi tcp-close                 Close the TCP conn
  e355scpi tcp-send                  Send data over TCP
  e355scpi tcp-recv                  Receive data from TCP
  e355scpi device-reboot             Reboot the device
  e355scpi unlock-nb85               Unlock NB85 modem UART
  e355scpi sci-loopback <status>     Turn on/off loopback of SCI pins
  e355scpi send <line>               Send single line to the deivce
  e355scpi at                        Run AT script loaded from a file or read
                                     from stdin
  e355scpi forward <status>          Turn on/off forwarding between modem and
                                     optical head

Options:
      --version  Show version number                                   [boolean]
  -d, --device   serial device name                                   [required]
  -b, --baud     serial device baudrate                 [number] [default: 9600]
  -u, --mtu      maximum send/receive size of socket data
                                                        [number] [default: 1200]
      --optical  is using optical head                 [boolean] [default: true]
  -h, --help     Show help                                             [boolean]
```
