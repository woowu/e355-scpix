## Description
E355 SCPI Tool is a handy tool that makes it easier to access SCPI interface of PIcasso meters.

It gives you:

* Easy access to meter scpi interface
* High level scenario-based commands that auto your test
* Easy way to play with the modem inside the meter
* Unblock some version (NB85) of meter firmware which block the access to the modem

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

## Installation

1. Download and install [nodejs](https://nodejs.org/en) in your OS.
2. Download this repo: git clone https://github.com/woowu/e355-scpix.git. (If
   you have offline copy, you can skip the downloading and unzip the zip file
   locally)
3. Run `npm install` inside the cloned folder.
4. Play with the tool with: `node src/e355-scpi.js`

## Examples

Note: in all the examples below, the serial device is named /dev/ttyUSB0, which
is the case in my Linux. In Windows, it should be, like COM3 or so.

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

```bash
~/coding/e355-scpix $ node src/e355-scpix.js -d /dev/ttyUSB0 tcp-ping -a 116.6.51.98:9005 -s 200 -n 5
> SER:CON ON
> at+qiopen=1,0,"TCP","116.6.51.98",9005,0,0
< OK *
send data. len 200
> at+qisend=0,200
< MODEM > *
> Adipisicing veniam ex proident ad ea ullamco aliqua enim voluptate pariatur sunt aute proident Lorem do irure ullamco exercitation quis veniam aute
 officia cillum Lorem ipsum sit duis ut nisi sunt et
< SEND OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 200
Adipisicing veniam ex proident ad ea ullamco aliqua enim voluptate pariatur sunt aute proident Lorem do irure ullamco exercitation quis veniam aute o
fficia cillum Lorem ipsum sit duis ut nisi sunt et

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
< Adipisicing veniam ex proident ad ea ullamco aliqua enim voluptate pariatur sunt aute proident Lorem do irure ullamco exercitation quis veniam aute
 officia cillum Lorem ipsum sit duis ut nisi sunt et
send data. len 200
> at+qisend=0,200
< MODEM > *
> Est est magna proident nisi qui incididunt ipsum proident ut magna laborum eu enim mollit sunt sit. In nisi ipsum ex incididunt non fugiat aliqua c
ommodo et pariatur cillum tempor laborum laborum amet
< SEND OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 200
Est est magna proident nisi qui incididunt ipsum proident ut magna laborum eu enim mollit sunt sit. In nisi ipsum ex incididunt non fugiat aliqua com
modo et pariatur cillum tempor laborum laborum amet

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
< Est est magna proident nisi qui incididunt ipsum proident ut magna laborum eu enim mollit sunt sit. In nisi ipsum ex incididunt non fugiat aliqua c
ommodo et pariatur cillum tempor laborum laborum amet
send data. len 200
> at+qisend=0,200
< MODEM > *
> Velit dolor amet laborum cillum nostrud ipsum commodo est commodo qui esse occaecat nostrud ullamco. Magna enim dolore nostrud ea tempor ipsum comm
odo dolore laboris ad ipsum nulla exercitation deseru
< SEND OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 200
Velit dolor amet laborum cillum nostrud ipsum commodo est commodo qui esse occaecat nostrud ullamco. Magna enim dolore nostrud ea tempor ipsum commod
o dolore laboris ad ipsum nulla exercitation deseru

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
< Velit dolor amet laborum cillum nostrud ipsum commodo est commodo qui esse occaecat nostrud ullamco. Magna enim dolore nostrud ea tempor ipsum comm
odo dolore laboris ad ipsum nulla exercitation deseru
send data. len 200
> at+qisend=0,200
< MODEM > *
> Consectetur anim voluptate cillum sint elit id sint dolor commodo consequat tempor dolor veniam consectetur nulla officia culpa velit anim exercita
tion pariatur dolore qui nostrud minim elit sit elit
< SEND OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 200
Consectetur anim voluptate cillum sint elit id sint dolor commodo consequat tempor dolor veniam consectetur nulla officia culpa velit anim exercitati
on pariatur dolore qui nostrud minim elit sit elit

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
< Consectetur anim voluptate cillum sint elit id sint dolor commodo consequat tempor dolor veniam consectetur nulla officia culpa velit anim exercita
tion pariatur dolore qui nostrud minim elit sit elit
send data. len 200
> at+qisend=0,200
< MODEM > *
> Fugiat dolor laboris consequat eiusmod officia qui deserunt elit magna labore in incididunt eu ut dolore Lorem quis est consequat voluptate. Nisi n
ulla amet Lorem mollit non in non laboris minim paria
< SEND OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
> at+qird=0,1006
< +QIRD: 200
Fugiat dolor laboris consequat eiusmod officia qui deserunt elit magna labore in incididunt eu ut dolore Lorem quis est consequat voluptate. Nisi nul
la amet Lorem mollit non in non laboris minim paria

OK *
> at+qird=0,1006
< +QIRD: 0

OK *
< Fugiat dolor laboris consequat eiusmod officia qui deserunt elit magna labore in incididunt eu ut dolore Lorem quis est consequat voluptate. Nisi n
ulla amet Lorem mollit non in non laboris minim paria
> at+qiclose=0
[MODEM TIMEOUT]
[MODEM TIMEOUT]
< MODEM TIMEOUT *
> +++
sent 5 messages, ttl 1000 bytes
recved 5 messages, ttl 1000 bytes
used 32.263 secs
```
