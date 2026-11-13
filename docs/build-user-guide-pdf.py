"""Build the illustrated Winger first-time user guide."""

from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib.colors import Color, white
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
)

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "guide-images"
OUT = ROOT / "Winger-user-guide.pdf"

GREEN = Color(0.106, 0.263, 0.204)
INK = Color(0.12, 0.14, 0.13)
MUTED = Color(0.33, 0.36, 0.34)


def trim(path: Path) -> Path:
    im = PILImage.open(path).convert("RGB")
    w, h = im.size
    pix = im.load()
    bg = pix[8, h - 4]

    def ink(x, y):
        r, g, b = pix[x, y]
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 28

    last = 0
    for y in range(h):
        if any(ink(x, y) for x in range(0, w, 3)):
            last = y
    cropped = im.crop((0, 0, w, min(h, last + 28)))
    dest = path.with_name(path.stem + "-trim.jpg")
    cropped.save(dest, quality=86, optimize=True)
    return dest


def phone(path: Path, max_h=168 * mm):
    src = trim(path)
    im = PILImage.open(src)
    w, h = im.size
    max_w = 78 * mm
    scale = min(max_w / w, max_h / h)
    return Image(str(src), width=w * scale, height=h * scale)


def styles():
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            textColor=GREEN,
            fontName="Times-Bold",
            fontSize=22,
            leading=26,
            spaceAfter=6,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            textColor=GREEN,
            fontName="Times-Bold",
            fontSize=15,
            leading=19,
            spaceBefore=8,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["BodyText"],
            textColor=INK,
            fontName="Times-Roman",
            fontSize=11,
            leading=15,
            alignment=TA_LEFT,
            spaceAfter=4,
        ),
        "step": ParagraphStyle(
            "step",
            parent=base["BodyText"],
            textColor=INK,
            fontName="Times-Roman",
            fontSize=11,
            leading=14,
        ),
        "caption": ParagraphStyle(
            "caption",
            parent=base["BodyText"],
            textColor=MUTED,
            fontName="Times-Italic",
            fontSize=9,
            leading=12,
            spaceBefore=2,
            spaceAfter=8,
        ),
    }


def steps(items, style):
    return ListFlowable(
        [ListItem(Paragraph(item, style), leftIndent=12) for item in items],
        bulletType="1",
        start="1",
        leftIndent=16,
        bulletFontName="Times-Bold",
        bulletFontSize=11,
        bulletColor=GREEN,
        spaceBefore=2,
        spaceAfter=6,
    )


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(GREEN)
    canvas.rect(0, A4[1] - 12 * mm, A4[0], 12 * mm, fill=1, stroke=0)
    canvas.setFillColor(white)
    canvas.setFont("Times-Bold", 9)
    canvas.drawString(16 * mm, A4[1] - 8 * mm, "Winger  ·  First-time user guide")
    canvas.setFillColor(MUTED)
    canvas.setFont("Times-Roman", 8)
    canvas.drawString(16 * mm, 8 * mm, "wingermarket.com")
    canvas.drawRightString(A4[0] - 16 * mm, 8 * mm, str(doc.page))
    canvas.restoreState()


def build():
    s = styles()
    story = []

    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Winger user guide", s["h1"]))
    story.append(
        Paragraph(
            "For a first visit to the shop, from signing in to checkout, and for a new supplier, from creating an account to shipping an order.",
            s["body"],
        )
    )
    story.append(
        Paragraph(
            "Open <b>https://wingermarket.com</b> or the Winger Android app. On the welcome screen you can switch the language to English, Español, or Kiswahili. Choose <b>Shop as a customer</b> to buy, or <b>Become a Supplier</b> to sell.",
            s["body"],
        )
    )

    story.append(Paragraph("Customers", s["h1"]))
    story.append(Paragraph("1. Sign in or create an account", s["h2"]))
    story.append(
        steps(
            [
                "On the welcome screen, choose <b>Shop as a customer</b>.",
                "If you already have an account, enter your email and password, then tap <b>Continue</b>.",
                "If you are new, tap <b>New here? Create an account</b>. Leave <b>Shop as a customer</b> selected, enter your full name, email, and password, then tap <b>Create account</b>.",
                "If the screen says the API is offline, wait a moment and tap <b>Continue</b> again.",
            ],
            s["step"],
        )
    )
    story.append(phone(IMAGES / "01-welcome.jpg", max_h=150 * mm))
    story.append(Paragraph("Welcome screen. Choose Shop as a customer, then Continue.", s["caption"]))
    story.append(phone(IMAGES / "01b-signup.jpg", max_h=120 * mm))
    story.append(Paragraph("Create an account. Customers use the left-hand choice.", s["caption"]))

    story.append(Paragraph("2. Find a product", s["h2"]))
    story.append(
        steps(
            [
                "<b>Home</b> shows the catalogue. The number of products across the screen follows the size of your phone or window.",
                "Use the search box, or open <b>Search</b>, and look up a name such as shoes or a brand.",
                "Tap a product to open it. The heart saves it to your wishlist. The cart icon adds it with the colour and size currently selected.",
            ],
            s["step"],
        )
    )
    story.append(phone(IMAGES / "02-home.jpg"))
    story.append(Paragraph("Home. Search, categories, and products with colour dots.", s["caption"]))

    story.append(Paragraph("3. Choose a colour and a size", s["h2"]))
    story.append(
        steps(
            [
                "Under the colour choices, tap a colour. The large photo changes to the picture saved for that colour.",
                "Under <b>Select size</b>, tap a size. A size that is out of stock cannot be added.",
                "Set the quantity.",
                "Choose <b>Express 1–2 days</b>, <b>Standard 3–5 days</b>, or <b>Pickup</b>.",
                "Tap <b>Add to cart</b>. The cart line shows the colour and size, for example black · 39.",
            ],
            s["step"],
        )
    )
    story.append(phone(IMAGES / "03-product.jpg"))
    story.append(
        Paragraph(
            "Product page. White is selected, size 39 is selected, and standard delivery is chosen.",
            s["caption"],
        )
    )

    story.append(Paragraph("4. Check out", s["h2"]))
    story.append(
        steps(
            [
                "Open <b>Cart</b> and check the supplier, the colour and size, and the total.",
                "Tap <b>Checkout all products</b>.",
                "<b>Review.</b> Confirm the items, then tap <b>Continue</b>.",
                "<b>Address.</b> Enter the street or area, the city, and a phone number the supplier can call. The phone needs at least 7 digits.",
                "<b>Delivery.</b> Choose express, standard, or pickup. The delivery fee and tax are shown before you continue.",
                "<b>Payment.</b> Choose <b>Card</b> or <b>Pay on delivery</b>, then tap <b>Place order</b>.",
                "<b>Confirmation.</b> You receive an order number, such as WG-10118. Pay on delivery means you pay the supplier when the order arrives.",
            ],
            s["step"],
        )
    )

    story.append(Paragraph("5. Follow the order", s["h2"]))
    story.append(
        Paragraph(
            "Open <b>Orders</b> and tap the order. You will see the product, the colour and size, the delivery address, and the shipment status. Status moves from processing, to shipped or ready for pickup, to delivered.",
            s["body"],
        )
    )
    story.append(phone(IMAGES / "05-orders.jpg"))
    story.append(Paragraph("Orders. Each card shows the supplier, the product, and how you will pay.", s["caption"]))
    story.append(phone(IMAGES / "06-order-detail.jpg", max_h=140 * mm))
    story.append(
        Paragraph(
            "Order WG-10118. The sandal is listed as black and brown, size 39, with the delivery address and pay on delivery.",
            s["caption"],
        )
    )

    story.append(PageBreak())
    story.append(Paragraph("Suppliers", s["h1"]))
    story.append(Paragraph("1. Create a supplier account", s["h2"]))
    story.append(
        steps(
            [
                "On the welcome screen, tap <b>New here? Create an account</b>.",
                "Select <b>Become a Supplier</b>.",
                "Enter your full name, email address, and password.",
                "Enter the <b>Business name</b>. This is the name shoppers see on your products.",
                "The preferred supplier id is optional. Leave it blank to let Winger assign one.",
                "Tap <b>Create account</b>.",
                "Next time, choose <b>Become a Supplier</b> on the welcome screen, sign in, and tap <b>Continue</b>.",
            ],
            s["step"],
        )
    )
    story.append(phone(IMAGES / "07-signup-supplier.jpg", max_h=150 * mm))
    story.append(
        Paragraph(
            "Supplier signup. Business name is shown on your profile. The supplier id can be left blank.",
            s["caption"],
        )
    )

    story.append(Paragraph("2. Add a product", s["h2"]))
    story.append(
        steps(
            [
                "Open <b>Products</b> and tap <b>Add product</b>.",
                "Add photos. You can add up to 8 images: JPG, JPEG, PNG, WebP, or GIF, at least 600×600 pixels, and no larger than 5 MB. Use your own photos.",
                "Enter the name, brand, price, and stock, then save.",
            ],
            s["step"],
        )
    )

    story.append(Paragraph("3. Add colours and sizes", s["h2"]))
    story.append(
        Paragraph(
            "Keep one product. Do not create a separate product for every colour.",
            s["body"],
        )
    )
    story.append(
        steps(
            [
                "On the product, tap <b>Product options</b>.",
                "Add one row for each combination. Example: Black and 39, then Black and 40, then White and 39.",
                "Enter the stock for that exact colour and size.",
                "A colour hex such as #1A1A1A sets the colour of the dot. It is optional when the colour name is a common one such as black, white, or brown.",
                "Save.",
            ],
            s["step"],
        )
    )
    story.append(
        Paragraph(
            "Use the same colour name every time. Black and black and brown are different colours to the shop. The photo shown to the shopper is the one saved for that exact colour name. <b>Receive +20</b> adds twenty units when you are not tracking each colour and size separately.",
            s["body"],
        )
    )

    story.append(Paragraph("4. Set delivery", s["h2"]))
    story.append(
        Paragraph(
            "Open <b>Delivery fees</b>. Choose whether you deliver the order yourself, or a courier delivers it. Enter the courier name when you use a courier. Shoppers then see express, standard, or pickup, and the fee for your products.",
            s["body"],
        )
    )

    story.append(Paragraph("5. Read a new order", s["h2"]))
    story.append(
        Paragraph("Open <b>Orders</b> when a shopper checks out. Each line shows:", s["body"])
    )
    story.append(
        steps(
            [
                "The product name.",
                "The colour and size the shopper chose.",
                "The customer’s phone number, which you can tap to call.",
                "Whether they will pay by card or on delivery.",
            ],
            s["step"],
        )
    )

    story.append(Paragraph("6. Ship the order", s["h2"]))
    story.append(
        steps(
            [
                "Tap <b>Fulfillment</b> and choose <b>Ship</b> or <b>Pickup</b>.",
                "For a shipment you handle yourself, tap <b>Mark shipped</b>. For a courier order, tap <b>Book courier</b>, then add the courier fee and tracking link under <b>Courier details</b>.",
                "When the customer has the item, tap <b>Mark delivered</b>.",
                "If the order is pay on delivery, tap <b>Collect payment</b> after you receive the money.",
                "Pickup orders are marked ready for the customer to collect, then <b>Mark delivered</b> when they take them.",
                "If you cannot send an item, tap <b>Cannot fulfil</b> while it is still processing. After a return, use <b>Returns</b> or <b>Create replacement</b>.",
            ],
            s["step"],
        )
    )
    story.append(Spacer(1, 4 * mm))
    story.append(
        Paragraph(
            "The pictures in this guide were taken from the live shop at wingermarket.com.",
            s["caption"],
        )
    )

    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=18 * mm,
        bottomMargin=16 * mm,
        title="Winger user guide",
        author="Winger",
    )
    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(OUT)


if __name__ == "__main__":
    build()
