"""Build a monochrome US Letter wiring sheet as SVG and PDF.

Uses only the Python standard library.
Pinout: Raspberry Pi 4 Model B datasheet, Figure 3.
https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4-datasheet.pdf
"""
import json
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 612, 792
svg, pdf = [], []


def line(x1, y1, x2, y2, width=0.8):
    svg.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke-width="{width}"/>')
    pdf.append(f'{width} w {x1} {HEIGHT-y1} m {x2} {HEIGHT-y2} l S')


def rect(x, y, w, h, width=0.8):
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" stroke-width="{width}"/>')
    pdf.append(f'{width} w {x} {HEIGHT-y-h} {w} {h} re S')


def circle(x, y, radius=2.5, fill=False):
    svg.append(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="{"black" if fill else "white"}"/>')
    y = HEIGHT-y
    r, k = radius, radius * 0.552284749831
    pdf.append(
        f'0.8 w {x+r} {y} m '
        f'{x+r} {y+k} {x+k} {y+r} {x} {y+r} c '
        f'{x-k} {y+r} {x-r} {y+k} {x-r} {y} c '
        f'{x-r} {y-k} {x-k} {y-r} {x} {y-r} c '
        f'{x+k} {y-r} {x+r} {y-k} {x+r} {y} c '
        + ('f' if fill else 'S')
    )


def text(x, y, value, size=9, bold=False, anchor="start"):
    svg.append(
        f'<text x="{x}" y="{y}" font-size="{size}" '
        f'font-weight="{"bold" if bold else "normal"}" text-anchor="{anchor}">{escape(value)}</text>'
    )
    # Base-14 Courier has a fixed glyph width of 0.6 em.
    if anchor == "middle":
        x -= len(value) * size * 0.3
    elif anchor == "end":
        x -= len(value) * size * 0.6
    escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
    pdf.append(f'BT /{"F2" if bold else "F1"} {size} Tf 1 0 0 1 {x:g} {HEIGHT-y} Tm ({escaped}) Tj ET')


def lines(x, y, values, size=8.4, leading=13):
    for offset, value in enumerate(values):
        text(x, y+offset*leading, value, size)


# All 40 physical J8 pins; GPIO numbers use BCM numbering.
left = ['3V3', 'GPIO2', 'GPIO3', 'GPIO4', 'GND', 'GPIO17', 'GPIO27',
        'GPIO22', '3V3', 'GPIO10', 'GPIO9', 'GPIO11', 'GND', 'GPIO0',
        'GPIO5', 'GPIO6', 'GPIO13', 'GPIO19', 'GPIO26', 'GND']
right = ['5V', '5V', 'GND', 'GPIO14', 'GPIO15', 'GPIO18', 'GND',
         'GPIO23', 'GPIO24', 'GND', 'GPIO25', 'GPIO8', 'GPIO7', 'GPIO1',
         'GND', 'GPIO12', 'GND', 'GPIO16', 'GPIO20', 'GPIO21']
pin_names = {2*i+1: label for i, label in enumerate(left)}
pin_names.update({2*i+2: label for i, label in enumerate(right)})

# Keep the drawing tied to the controller's actual switch configuration.
config = json.loads((ROOT / 'gpio-controller/pedals.json').read_text())
switches = config['switches'][:3]
physical = {17: 11, 27: 13, 22: 15}
assert [s['gpio'] for s in switches] == [17, 27, 22]
assert all(pin_names[physical[s['gpio']]] == f"GPIO{s['gpio']}" for s in switches)
used = {6, *(physical[s['gpio']] for s in switches)}

text(28, 32, '3PDT PEDAL TO RASPBERRY PI 4 MODEL B', 14, True)
text(28, 49, 'WIRING SPECIFICATION  |  LATCHING SWITCH  |  3.3 V GPIO INPUT', 9)
line(28, 60, 584, 60, 1)

text(28, 80, 'J8 - 40-PIN GPIO HEADER', 10, True)
text(28, 96, 'Top view. USB/Ethernet ports at bottom.', 8)

# Rotate the conventional board view clockwise: GPIO on the right.
# Pin 1 is at the top of the inner pin row.
rect(78, 110, 100, 70)
rect(73, 119, 10, 16)
text(68, 129, 'USB-C', 7, anchor='end')
rect(90, 170, 23, 14)
rect(119, 170, 23, 14)
rect(148, 170, 23, 14)
text(128, 196, 'USB / ETHERNET', 7, anchor='middle')
rect(151, 113, 22, 52)
for x, value in [(157, '1'), (167, '2')]:
    text(x, 122, value, 6.5, True, 'middle')
    text(x, 145, ':', 7, anchor='middle')
text(157, 160, '39', 6, anchor='middle')
text(167, 160, '40', 6, anchor='middle')
text(187, 126, 'J8', 8, True)
text(28, 214, 'Pin 1 has a square solder pad.', 8)

for i, (odd_label, even_label) in enumerate(zip(left, right)):
    y = 233 + i*13.5
    for pin, cx in [(2*i+1, 130), (2*i+2, 160)]:
        rect(cx-10, y-9.5, 20, 12, 1.8 if pin in used else 0.5)
        text(cx, y, str(pin), 8, pin in used, 'middle')
    text(112, y, odd_label, 8.5, 2*i+1 in used, 'end')
    text(178, y, even_label, 8.5, 2*i+2 in used)
text(28, 512, 'Box numbers = physical header pins.', 8)
text(28, 525, 'Heavy boxes = pedal 1-3 connections.', 8)

text(282, 80, 'PEDAL 1 - CIRCUIT', 10, True)
text(287, 112, 'J8 pin 11', 8.5)
text(287, 125, '(GPIO17)', 8.5)
line(287, 143, 350, 143)
rect(350, 137, 40, 12)
text(370, 129, 'R1 1k', 8.5, anchor='middle')
line(390, 143, 430, 143)
circle(430, 143, 2.5, True)
text(420, 163, 'C', 9, True)
line(430, 143, 476, 111, 1)
circle(482, 107)
circle(482, 181)
text(477, 96, 'T', 9, True)
text(494, 184, 'OPEN', 8)
line(482, 107, 560, 107)
line(560, 107, 560, 225)
line(560, 225, 300, 225)
line(300, 225, 300, 232)
line(290, 232, 310, 232)
line(293, 236, 307, 236)
line(297, 240, 303, 240)
text(320, 244, 'J8 pin 6 (GND)', 8.5)
text(282, 264, 'Use input mode + internal pull-up.', 8)

text(282, 292, 'SW1 - SOLDER TERMINAL VIEW', 10, True)
rect(303, 310, 145, 110)
for row in range(3):
    for col in range(3):
        x, y = 330+46*col, 327+36*row
        rect(x-7, y-7, 14, 14, 1.2 if (row, col) in {(1, 1), (2, 1)} else 0.5)
        if (row, col) == (1, 1):
            text(x, y+3, 'C', 9, True, 'middle')
        elif (row, col) == (2, 1):
            text(x, y+3, 'T', 9, True, 'middle')
line(383, 363, 398, 363)
line(398, 363, 398, 345)
line(398, 345, 461, 345)
text(468, 348, 'C to R1', 8)
line(383, 399, 398, 399)
line(398, 399, 398, 417)
line(398, 417, 461, 417)
text(468, 420, 'T to pin 6', 8)
lines(282, 439, [
    'C = center terminal (common).',
    'T = adjacent terminal verified by meter.',
    'With Pi unplugged, C-T must alternate',
    'between continuity and open each click.',
    'Rotate switch to match this view.',
    'Leave other 7 terminals unconnected.',
], size=8, leading=13)

line(28, 545, 584, 545)
text(28, 565, 'CONNECTION TABLE - ONE 1k RESISTOR PER PEDAL', 10, True)
text(35, 588, 'PEDAL', 8.5, True)
text(100, 588, 'SIGNAL WIRE', 8.5, True)
text(448, 588, 'GROUND WIRE', 8.5, True)
line(28, 596, 584, 596)
for i, switch in enumerate(switches):
    y = 614+i*22
    text(44, y, switch['id'], 9)
    text(100, y, f"C -> 1k -> J8 pin {physical[switch['gpio']]} (GPIO{switch['gpio']})", 9)
    text(448, y, 'T -> J8 pin 6', 9)
line(28, 668, 584, 668)
lines(28, 688, [
    'All T wires share ground. Keep the C signal wires separate.',
    'Software: internal pull-up; one action on either stable switch change.',
    'Connect with Pi power removed. Leave 3V3 and 5V pins unconnected.',
], size=8.5, leading=16)
line(28, 734, 584, 734)
text(28, 749, 'Pinout source: Raspberry Pi 4 Model B datasheet, Figure 3.', 7)
text(28, 761, 'https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4-datasheet.pdf', 7)
text(28, 774, 'Controller pin map: gpio-controller/pedals.json', 7)

svg_header = f'''<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 {WIDTH} {HEIGHT}">
<title>3PDT pedal to Raspberry Pi 4 - GPIO wiring specification</title>
<desc>Physical pin 11 GPIO17 through a 1k resistor to switch common C; terminal T to physical pin 6 ground. Full 40-pin header, nine-terminal switch view, and pins for three pedals. Confirm C-T continuity alternates with each click; rotate the switch to match the view.</desc>
<rect width="612" height="792" fill="white"/>
<g stroke="black" fill="none" stroke-width="0.8">
<style>text{{font-family:"Courier New",Courier,monospace;stroke:none;fill:black}}</style>
'''
svg_path = ROOT / 'raspberry_pi_katana_wiring.svg'
svg_path.write_text(svg_header+'\n'.join(svg)+'\n</g>\n</svg>\n')

# Vector PDF with standard built-in Courier fonts.
stream = ('1 g 0 0 612 792 re f\n0 G 0 g\n'+'\n'.join(pdf)+'\n').encode('ascii')
objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'endstream',
]
data = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(data))
    data.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
xref = len(data)
data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]:
    data.extend(f'{offset:010d} 00000 n \n'.encode())
data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
pdf_path = ROOT / 'raspberry_pi_katana_wiring.pdf'
pdf_path.write_bytes(data)
print(svg_path)
print(pdf_path)
