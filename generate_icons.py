
import os
from PIL import Image, ImageDraw, ImageFont

def create_icon(size, path):
    img = Image.new('RGB', (size, size), color = '#6366f1')
    d = ImageDraw.Draw(img)
    # Just a simple "S" text or similar would require a font, 
    # let's just make a simple colored square with a white circle for now to avoid font issues
    # unless we can use default font.
    
    # Draw a white circle in the middle
    center = size // 2
    radius = size // 4
    d.ellipse((center - radius, center - radius, center + radius, center + radius), fill='white')
    
    img.save(path)

if not os.path.exists('web/icons'):
    os.makedirs('web/icons')

create_icon(192, 'web/icons/icon192.png')
create_icon(512, 'web/icons/icon512.png')
print("Icons generated")
