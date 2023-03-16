## ELPP - the Measurement{Earth} (Enhanced) Low Power Protocol

This protocol takes the best of all the worlds (IoT and blockchain) and creates a unique and dynamic framework for doing just about anything over a wired or wireless link.

Especially suited to IoT devices running LoRaWAN, Sigfox and Satellite communication links with traditional cloud or blockchain networks.

The protocol includes a reference implementation Javascript decoder engine that has been made available here.

Devices implementing this protocol include the Measurement{Earth} Operating System firmware and Trusted Sensor Platform sensor hardware modules.



### Basic Principles

This protocol is defined by data channels, not message types.  There are an unlimited number of message types and many have been defined here.

The data channel is conveyed on the wire by a single byte.  The channel is mapped identically on both the device and the cloud platform to a fixed message type. 
In this way, the application can, and must, know that the temperature sensor mapped to channel 3 is the 'front' sensor and the temperature sensor
mapped to channel 4 is the 'back' temperature sensor.  Channel 5 can send battery level and 6 particulate matter data.  Channel 10 can be assigned to firmware update messages, and so on.

There are downlink configuration message types too.  For a system with 5 sensors, 5 configuration channels can be assigned to sensor configuration message types (maybe this is reporting period)
The protocol suggests that the same configuration message is reflected back on the same channel in the uplink payload to confirm the downlink command.

The message types are defined by decoders.  Decoders are built as heirarchies consisting of arrays of decoders and/or primitive decoders.  The primitive decoders do the actual data extraction and decoding from the byte buffer.

There are only a few primitive decoder types defined. These include: var(u)int32 types, fixed and dynamic arrays, 'name' types and Q-format bitfields.


### Messages

