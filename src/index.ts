/*
  # Author : Watchara Pongsri
  # [github/X-c0d3] https://github.com/X-c0d3/
  # Web Site: https://www.rockdevper.com
*/

import { SerialPort } from 'serialport';

interface SerialConfig {
    path: string;
    baudRate: number;
}

const config: SerialConfig = {
    path: '/dev/tty.usbserial-0001',
    baudRate: 9600,
};

const port: SerialPort = new SerialPort({
    path: config.path,
    baudRate: config.baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
});

/**
 * ฟังก์ชันสร้างและคำนวณแพ็กเก็ต Pace V2.5
 */
const generatePacePacket = (cid2: string, lengthAndData: string): Buffer => {
    const protocolVersion = '25';
    const address = '01';
    const cid1 = '46';

    const asciiPayload = `${protocolVersion}${address}${cid1}${cid2}${lengthAndData}`;

    let sum = 0;
    for (let i = 0; i < asciiPayload.length; i++) {
        sum += asciiPayload.charCodeAt(i);
    }
    const lrc = ((~sum + 1) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    return Buffer.from(`~${asciiPayload}${lrc}\r`, 'ascii');
};

const sendBmsRefreshCommand = (): void => {
    if (!port.isOpen) return;
    const finalBuffer = generatePacePacket('42', 'E00201');
    port.write(finalBuffer);
};

let rxBuffer = Buffer.alloc(0);
let rxTimeoutId: NodeJS.Timeout | null = null;

port.on('data', (chunk: Buffer): void => {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    if (rxTimeoutId) clearTimeout(rxTimeoutId);
    rxTimeoutId = setTimeout(() => {
        processBmsTelemetry(rxBuffer);
        rxBuffer = Buffer.alloc(0);
    }, 200);
});

/**
 * ฟังก์ชันถอดรหัสและจัดตำแหน่งข้อมูลตามหน้า App จริงของ LVTopsun V2.5
 */
const processBmsTelemetry = (buffer: Buffer): void => {
    const rawStr = buffer.toString('utf-8').trim();

    if (!rawStr.startsWith('~') || rawStr.length < 150) return;

    const rtnStatus = rawStr.substring(7, 9);
    if (rtnStatus !== '00') return;

    try {
        console.log('\n======================================================');
        console.log('⚡ [LVTopsun BMS Telemetry Data - ONLINE]');
        console.log('======================================================');

        let idx = 17;

        // 1. แกะค่าแรงดันไฟฟ้ารายเซลล์
        const cellCount = parseInt(rawStr.substring(idx, idx + 2), 16);
        idx += 2;

        for (let i = 0; i < cellCount; i++) {
            const cellVolt = parseInt(rawStr.substring(idx, idx + 4), 16) / 1000;
            console.log(`🔋 Cell ${String(i + 1).padStart(2, '0')} : ${cellVolt.toFixed(3)} V`);
            idx += 4;
        }

        // 2. แกะค่าอุณหภูมิระบบ (มัดรวม 6 จุดจากบอร์ด)
        const tempCount = parseInt(rawStr.substring(idx, idx + 2), 16);
        idx += 2;

        const rawTemperatures: number[] = [];
        for (let t = 0; t < tempCount; t++) {
            const tempVal = (parseInt(rawStr.substring(idx, idx + 4), 16) - 2731) / 10;
            rawTemperatures.push(tempVal);
            idx += 4;
        }

        // [จุดแก้ไข] แยกประเภทอุณหภูมิตามพิกัดจริงของ App
        const cellTemperatures = rawTemperatures.slice(0, 4); // จุดที่ 1-4 คืออุณหภูมิเซลล์แบตเตอรี่
        const mosTemperature = rawTemperatures[4] ?? 0;       // จุดที่ 5 คืออุณหภูมิ MOSFET
        const ambientTemperature = rawTemperatures[5] ?? 0;   // จุดที่ 6 คืออุณหภูมิกล่อง/สภาพแวดล้อม

        // คำนวณค่าทางสถิติเพิ่มเติมเหมือนในหน้าแอป
        const maxCellTemp = Math.max(...cellTemperatures);
        const minCellTemp = Math.min(...cellTemperatures);
        const cellTempDiff = maxCellTemp - minCellTemp;

        // แสดงผลอุณหภูมิแบบแยกหมวดหมู่
        console.log('------------------------------------------------------');
        console.log(`🌡️  PACK Cell Temp    : ${cellTemperatures.map((t, i) => `[${i + 1}] ${t.toFixed(1)}°C`).join(' | ')}`);
        console.log(`🌡️  Max/Min Temp Diff : Max: ${maxCellTemp.toFixed(1)}°C | Min: ${minCellTemp.toFixed(1)}°C | Diff: ${cellTempDiff.toFixed(1)}°C`);
        console.log(`🔥 MOS Temperature   : ${mosTemperature.toFixed(1)}°C`);
        console.log(`🌬️  Ambient Temp     : ${ambientTemperature.toFixed(1)}°C`);
        console.log('------------------------------------------------------');

        // 3. แกะพาร์ทกระแสไฟฟ้า และแรงดันไฟฟ้ารวม
        let currentRaw = parseInt(rawStr.substring(idx, idx + 4), 16);
        if (currentRaw > 0x7FFF) currentRaw -= 0x10000;
        const currentAmps = currentRaw / 100;
        idx += 4;

        const totalVoltage = parseInt(rawStr.substring(idx, idx + 4), 16) / 1000;
        idx += 4;

        // ข้ามกลุ่มบิตสถานะความปลอดภัย และ Warning Flag Count
        idx += 4;
        idx += 2;

        // 4. ถอดรหัสกลุ่มข้อมูลความจุและเปอร์เซ็นต์ตามสเปกบอร์ดจริง
        const designAh = parseInt(rawStr.substring(idx, idx + 4), 16) / 100;
        idx += 4;

        const cycleCount = parseInt(rawStr.substring(idx, idx + 4), 16);
        idx += 4;

        const fullAh = parseInt(rawStr.substring(idx, idx + 4), 16) / 100;
        idx += 4;

        const socHex = rawStr.substring(idx, idx + 2);
        const soc = parseInt(socHex, 16);

        const calculatedRemainAh = (fullAh * soc) / 100;

        console.log(`📊 Pack Voltage      : ${totalVoltage.toFixed(3)} V`);
        console.log(`🔌 Current           : ${currentAmps.toFixed(2)} A`);
        console.log(`🔋 Battery Capacity  : ${calculatedRemainAh.toFixed(2)} Ah / ${fullAh.toFixed(2)} Ah (Design: ${designAh.toFixed(0)} Ah)`);
        console.log(`🔄 Battery SoC       : ${soc.toFixed(1)}% (Cycle Count: ${cycleCount} รอบ)`);
        console.log('======================================================');

    } catch (error) {
        console.error('❌ ดำเนินการแกะโครงสร้างแพ็กเก็ตผิดพลาด:', error);
    }
};

port.on('open', (): void => {
    console.log(`✅ [ระบบทำงานสมบูรณ์แบบ 100%] เชื่อมต่อพอร์ต ${config.path} สำเร็จ!`);
    sendBmsRefreshCommand();
    setInterval(() => {
        sendBmsRefreshCommand();
    }, 2000);
});

port.on('error', (err) => console.error('💥 SerialPort Error:', err.message));

process.on('SIGINT', () => {
    if (port.isOpen) port.close(() => process.exit(0));
    else process.exit(0);
});