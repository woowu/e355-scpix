## Description
E355 SCPI Tool is a handy tool that makes it easier to access SCPI interface of PIcasso meters.

It gives you:

* commands and (grouped) options (`my-program.js serve --port=5000`).
* a dynamically generated help menu based on your arguments:

```
e355-scpix [command]

Commands:
  e355-scpix ping                      Test scpi connectivity by sending *IDN?
  e355-scpix modem-power <subcommand>  Turn on/off modem or query its power
                                       status
  e355-scpix modem-conf                Configure modem
  e355-scpix modem-info                Modem/network information
  e355-scpix pdp-activate              Activate PDP context.
  e355-scpix tcp-open                  Open the TCP conn
  e355-scpix tcp-close                 Close the TCP conn
  e355-scpix tcp-send                  Send data over TCP
  e355-scpix tcp-recv                  Receive data from TCP
  e355-scpix device-reboot             Reboot the device
  e355-scpix unlock-nb85               Unlock NB85 modem UART
  e355-scpix sci-loopback <status>     Turn on/off loopback of SCI pins
  e355-scpix send <line>               Send a scpi command to the deivce
  e355-scpix at                        Run AT script loaded from a file or read
                                       from stdin
  e355-scpix forward <status>          Turn on/off optical head forwarding

Options:
      --version  Show version number                                   [boolean]
  -d, --device   serial device name                                   [required]
  -b, --baud     serial device baudrate                 [number] [default: 9600]
  -u, --mtu      maximum send/receive size of socket data
                                                        [number] [default: 1200]
      --optical  is using optical head                 [boolean] [default: true]
  -h, --help     Show help                                             [boolean]
```

## Examples
```bash
$ e355-scpix -d /dev/ttyUSB0 unlock-nb85
> *IDN?
< LANDIS+GYR,"E360 AP SCPI",U.139.01.0F,0004
> PWRState:MONVolt 1600
< OK
use delay 3.647 secs
> WAN:LOOPback:STArt
WAN:LOOPback:STArt timeout
> *IDN?
< �ANDIS+GYR,"E360 AP SCPI",U.139.01.0F,0004
> *IDN?
< LANDIS+GYR,"E360 AP SCPI",U.139.01.0F,0004
> PWRState:MONVolt 1600
< OK
use delay 3.840 secs
> WAN:LOOPback:STArt
< OK
waiting 5 seconds for modem power up
> SER:CON ON
> at
< OK *
> +++
succeeded. modem UART has been unlocked
```

```bash
$ e355-scpix -d /dev/ttyUSB0 modem-config
> SER:CON ON
> ate0
< OK
> at+cmee=1
< OK
> at+cfun=1
< C�j�H�
> at+qcfg="gpio",1,26,0,0,0,0
< OK
> at+qcfg="gpio",1,85,1,0,0,0
< OK
> at+qcfg="gpio",3,85,1,1
< C�j�H�
> at+qcfg="gpio",1,64,0,0,0
< OK
> at+qcfg="gpio",3,64,0,0
< OK
> at+qcfg="gpio",1,65,0,0,0
< OK
> at+qcfg="gpio",3,65,0,0
< �
OK
> at+qcfg="gpio",1,66,0,0,0
< OK
> at+qcfg="gpio",3,66,0,0
< OK
> at+qcfg="band",0,8000004,0,1
< �
OK
> at+qcfg="band",0,0,95,1
< OK
> at+cops=0
< OK
> at+qcfg="iotopmode",1
< C�j�H�
> at+qicsgp=1,1,"","","",0
< C�j�H�
> +++
> SER:CON ON
> at+qcfg="gpio",2,26
< +QCFG: "gpio",1

OK
module with supcap
> at+qsclk=1
< OK
> +++
```

```bash
$ ./bin/e355-scpix -d /dev/ttyUSB0 tcp-open -a 116.6.51.98:9005
> SER:CON ON
> at+qiopen=1,0,"TCP","116.6.51.98",9005,0,0
< OK *
> +++
```

```bash
$ ./bin/e355-scpix -d /dev/ttyUSB0 tcp-send -n 100
> SER:CON ON
send data. len 100
> at+qisend=0,100
< MODEM > *
> Labore voluptate culpa dolor do Lorem veniam nisi Lorem deserunt enim cupidatat incididunt pariatur
< SEND OK *
> +++
~/coding/e355-scpix $ ./bin/e355-scpix -d /dev/ttyUSB0 tcp-recv
> SER:CON ON
> at+qird=0,1200
< +QIRD: 100
Labore voluptate culpa dolor do Lorem veniam nisi Lorem deserunt enim cupidatat incididunt pariatur

OK *
> at+qird=0,1200
< +QIRD: 0

OK *
> +++
Labore voluptate culpa dolor do Lorem veniam nisi Lorem deserunt enim cupidatat incididunt pariatur
```

```bash
$ socat -v -x TCP4-LISTEN:9005,fork EXEC:cat
> 2022/04/29 13:12:32.972315  length=100 from=0 to=99
 4c 61 62 6f 72 65 20 76 6f 6c 75 70 74 61 74 65  Labore voluptate
 20 63 75 6c 70 61 20 64 6f 6c 6f 72 20 64 6f 20   culpa dolor do
 4c 6f 72 65 6d 20 76 65 6e 69 61 6d 20 6e 69 73  Lorem veniam nis
 69 20 4c 6f 72 65 6d 20 64 65 73 65 72 75 6e 74  i Lorem deserunt
 20 65 6e 69 6d 20 63 75 70 69 64 61 74 61 74 20   enim cupidatat
 69 6e 63 69 64 69 64 75 6e 74 20 70 61 72 69 61  incididunt paria
 74 75 72 20                                      tur
--
< 2022/04/29 13:12:32.973858  length=100 from=0 to=99
 4c 61 62 6f 72 65 20 76 6f 6c 75 70 74 61 74 65  Labore voluptate
 20 63 75 6c 70 61 20 64 6f 6c 6f 72 20 64 6f 20   culpa dolor do
 4c 6f 72 65 6d 20 76 65 6e 69 61 6d 20 6e 69 73  Lorem veniam nis
 69 20 4c 6f 72 65 6d 20 64 65 73 65 72 75 6e 74  i Lorem deserunt
 20 65 6e 69 6d 20 63 75 70 69 64 61 74 61 74 20   enim cupidatat
 69 6e 63 69 64 69 64 75 6e 74 20 70 61 72 69 61  incididunt paria
 74 75 72 20                                      tur
--

```
