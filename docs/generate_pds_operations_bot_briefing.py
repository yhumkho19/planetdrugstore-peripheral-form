from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

from generate_system_walkthrough import (
    AMBER,
    GOLD,
    INK,
    LINE,
    MAROON,
    MINT,
    MUTED,
    PALE_BLUE,
    PAPER,
    RED,
    TEAL,
    WHITE,
    base_slide,
    card,
    footer,
    header,
    line,
    pill,
    rect,
    rgb,
    text,
)


OUTPUT = "pds-operations-bot-it-briefing.pptx"
W, H = 13.333, 7.5


def numbered_step(slide, number, title, body, x, color):
    rect(slide, x, 2.45, 2.72, 2.48, WHITE, radius=True, line=LINE)
    rect(slide, x + 0.22, 2.68, 0.43, 0.43, color, radius=True)
    text(slide, number, x + 0.22, 2.68, 0.43, 0.43, size=12, color=WHITE,
         bold=True, align=PP_ALIGN.CENTER, valign=MSO_ANCHOR.MIDDLE, margin=0.01)
    text(slide, title, x + 0.22, 3.32, 2.3, 0.55, size=15, color=INK, bold=True)
    text(slide, body, x + 0.22, 3.98, 2.3, 0.76, size=11, color=MUTED)


def make_deck():
    prs = Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    prs.core_properties.title = "PDS Operations Bot - IT Decision Brief"
    prs.core_properties.subject = "Purpose, workflow, and IT setup for the PDS Operations Teams bot"
    prs.core_properties.author = "Planet Drugstore"
    prs.core_properties.keywords = "PDS Operations, Teams bot, Contact Admin, IT approval"

    # 1. Cover
    slide = base_slide(prs, INK)
    rect(slide, 0, 0, 0.18, H, RED)
    rect(slide, 8.55, 0.72, 4.15, 6.02, "263642", radius=True)
    text(slide, "DECISION BRIEF  /  OCTOBER 2026", 0.82, 0.88, 6.6, 0.28,
         size=10, color="9AD3C5", bold=True)
    text(slide, "PDS Operations\nContact Admin Bot", 0.8, 1.62, 7.45, 1.72,
         size=33, color=WHITE, bold=True)
    text(slide, "A structured way for employees to raise event and schedule concerns in Teams.",
         0.84, 3.75, 6.95, 0.8, size=16, color="D5DEE4")
    pill(slide, "EMPLOYEE-INITIATED", 0.85, 5.25, 2.15, "D8EEE8", TEAL, 9)
    pill(slide, "NO AUTO-SEND", 3.18, 5.25, 1.65, "F5E4E2", MAROON, 9)
    text(slide, "PROPOSED TEAMS WORKFLOW", 8.95, 1.08, 3.2, 0.3,
         size=10, color="9AD3C5", bold=True)
    for yy, label, accent in [
        (1.72, "Notification action", TEAL),
        (2.65, "Prefilled bot chat", GOLD),
        (3.58, "Employee adds concern", MAROON),
        (4.51, "Posts to PDS Operations", RED),
    ]:
        rect(slide, 8.95, yy, 3.25, 0.58, "344652", radius=True)
        rect(slide, 9.15, yy + 0.18, 0.2, 0.2, accent, radius=True)
        text(slide, label, 9.55, yy + 0.11, 2.4, 0.32, size=12.2,
             color=WHITE, bold=True, valign=MSO_ANCHOR.MIDDLE)
    footer(slide, 1, "PLANET DRUGSTORE  /  INTERNAL DISCUSSION")

    # 2. Employee experience
    slide = base_slide(prs)
    header(slide, "01  /  Employee experience", "One tap opens a complete, editable report",
           "The employee reviews the details, adds the concern, and chooses whether to send it.")
    xs = [0.65, 3.78, 6.91, 10.04]
    colors = [TEAL, GOLD, MAROON, RED]
    steps = [
        ("Notification", "Employee taps Contact Admin from an assignment or schedule alert."),
        ("Prefilled draft", "Name, role, event site, and date are already included."),
        ("Employee sends", "Employee types the concern and presses Send; nothing sends automatically."),
        ("Channel post", "PDS Operations bot posts the report in the approved team channel."),
    ]
    for index, ((title, body), x, accent) in enumerate(zip(steps, xs, colors), start=1):
        numbered_step(slide, str(index), title, body, x, accent)
    for x in [3.42, 6.55, 9.68]:
        shape = slide.shapes.add_shape(MSO_SHAPE.CHEVRON, Inches(x), Inches(3.48), Inches(0.26), Inches(0.34))
        shape.fill.solid()
        shape.fill.fore_color.rgb = rgb(GOLD)
        shape.line.fill.background()
    rect(slide, 0.65, 5.52, 12.1, 0.78, MINT, radius=True)
    text(slide, "Draft format", 0.9, 5.75, 1.45, 0.24, size=12, color=TEAL, bold=True)
    text(slide, "Name  •  Role  •  Event Site  •  Date  •  Concern", 2.45, 5.73, 9.8, 0.28,
         size=13, color=INK, bold=True, valign=MSO_ANCHOR.MIDDLE)
    footer(slide, 2)

    # 3. Purpose and value
    slide = base_slide(prs)
    header(slide, "02  /  Purpose", "Why add a bot instead of another generic link?",
           "A report reaches the right team with context, while the employee stays in control of what is sent.")
    card(slide, 0.65, 2.12, 5.85, 3.72, "Without a structured flow",
         "• Employee has to find the correct Teams channel\n\n• Name, role, site, or date may be missing\n\n• Similar channels make misdirected concerns more likely\n\n• Admin may need to ask follow-up questions",
         MAROON, WHITE, 17, 12.5)
    card(slide, 6.83, 2.12, 5.85, 3.72, "With PDS Operations Bot",
         "• Contact action starts from the relevant notification\n\n• Assignment details are prefilled consistently\n\n• Employee enters the concern and explicitly sends\n\n• Bot posts a readable report to the approved channel",
         TEAL, WHITE, 17, 12.5)
    rect(slide, 0.65, 6.12, 12.03, 0.55, PALE_BLUE, radius=True)
    text(slide, "The bot does not read the team's messages or send a report without the employee's confirmation.",
         0.88, 6.24, 11.6, 0.28, size=11.8, color=INK, bold=True,
         align=PP_ALIGN.CENTER, valign=MSO_ANCHOR.MIDDLE)
    footer(slide, 3)

    # 4. IT ownership
    slide = base_slide(prs)
    header(slide, "03  /  Why IT", "The bot needs trusted access inside our Teams tenant",
           "These controls belong to the Microsoft 365 / Teams administrators, not to an individual employee.")
    items = [
        (0.65, TEAL, "Register", "Create the Teams app and bot identity in the organization tenant."),
        (3.78, GOLD, "Secure", "Store the client secret in the hosting environment; never in source or chat."),
        (6.91, MAROON, "Install", "Allow personal bot chats and install the bot in PDS Operations team."),
        (10.04, RED, "Connect", "Set the approved endpoint and bot ID used by notification actions."),
    ]
    for x, accent, title, body in items:
        card(slide, x, 2.35, 2.65, 2.65, title, body, accent, WHITE, 15, 11.2)
    rect(slide, 0.65, 5.48, 12.03, 0.93, AMBER, radius=True)
    text(slide, "If the bot is not installed in the team, it cannot post to the channel. If it is not installed for the employee, the prefilled bot chat may not open.",
         0.92, 5.68, 11.5, 0.52, size=11.2, color=INK, bold=True,
         align=PP_ALIGN.CENTER, valign=MSO_ANCHOR.MIDDLE)
    footer(slide, 4)

    # 5. Decision and next steps
    slide = base_slide(prs)
    header(slide, "04  /  Decision requested", "Approve an IT owner and the required setup",
           "The bot source, draft flow, tests, and container build are prepared; tenant registration is the remaining gate.")
    card(slide, 0.65, 2.08, 5.85, 3.85, "IT deliverables",
         "1. Public HTTPS host for the bot endpoint\n\n2. Teams app registration and generated bot ID\n\n3. Secure runtime credentials\n\n4. Install/allow the app in personal scope and PDS Operations team\n\n5. Configure the bot ID in the push worker",
         TEAL, WHITE, 17, 12)
    card(slide, 6.83, 2.08, 5.85, 3.85, "Approval requested from leadership",
         "• Assign a Microsoft 365 / Teams admin as owner\n\n• Approve hosting and app registration work\n\n• Confirm PDS Operations as the destination channel\n\n• Authorize a small employee pilot before broad rollout",
         MAROON, WHITE, 17, 12)
    rect(slide, 0.65, 6.18, 12.03, 0.48, PALE_BLUE, radius=True)
    text(slide, "Status: local build and tests pass. The bot is not yet searchable or active until IT registers and installs it.",
         0.88, 6.29, 11.6, 0.24, size=11.5, color=INK, bold=True,
         align=PP_ALIGN.CENTER, valign=MSO_ANCHOR.MIDDLE)
    footer(slide, 5)

    prs.save(OUTPUT)
    print(f"Created {OUTPUT} ({len(prs.slides)} slides)")


if __name__ == "__main__":
    make_deck()