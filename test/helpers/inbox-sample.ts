// A real job-hunting inbox (October 2026), sender and subject only, for the classifier
// tests. The companies actually applied to are renamed and the name is changed; the ads,
// alerts and newsletters are kept as they came, since those are what the rules must reject.
//
// `track` is the label a person gave each email: the organisation it should be tracked
// under (it has a confirmation), or null (ignore it).

export interface SampleEmail {
  date: string;
  from: string;
  subject: string;
  track: string | null;
}

export const INBOX_SAMPLE: SampleEmail[] = [
  // ----- confirmations: always tracked -----
  { date: "2026-10-19", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Pixelcraft SEO - Digital Marketing Agency", track: "Pixelcraft SEO - Digital Marketing Agency" },
  { date: "2026-10-18", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Zentrova", track: "Zentrova" },
  { date: "2026-10-18", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Quillo.ai", track: "Quillo.ai" },
  { date: "2026-10-18", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Fortnight (YC W21)", track: "Fortnight (YC W21)" },
  { date: "2026-10-17", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Northwind Consultancy Services", track: "Northwind Consultancy Services" },
  { date: "2026-10-16", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Mindforge", track: "Mindforge" },
  { date: "2026-10-16", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Adorix", track: "Adorix" },
  { date: "2026-10-04", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to skyhawk", track: "skyhawk" },
  { date: "2026-10-04", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Swift Hire Staffing", track: "Swift Hire Staffing" },
  { date: "2026-10-04", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Clearing Hurdles", track: "Clearing Hurdles" },
  { date: "2026-10-04", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your application was sent to Sea Buddies", track: "Sea Buddies" },
  { date: "2026-10-20", from: "Workable <noreply@candidates.workablemail.com>", subject: "Thanks for applying to Localy App", track: "Localy App" },
  { date: "2026-10-18", from: "acme@myworkday.com", subject: "Thank You For Applying!", track: "acme" },
  { date: "2026-09-27", from: "Yuva Spark Hackathon <yuvaspark@younoodle.com>", subject: "Your Application Has Been Successfully Submitted for Yuva Spark Energy Tech Hackathon 2026", track: "Yuva Spark Energy Tech Hackathon 2026" },
  { date: "2026-09-29", from: "Yuva Spark Hackathon <yuvaspark@younoodle.com>", subject: "Your Application Has Been Successfully Submitted for Yuva Spark Energy Tech Hackathon 2026", track: "Yuva Spark Energy Tech Hackathon 2026" },

  // ----- follow-ups of a confirmed application: tracked with it -----
  { date: "2026-10-07", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Your application to Software Engineer (IITs only) at Sea Buddies", track: "Sea Buddies" },

  // ----- follow-ups with no confirmation behind them: ignored -----
  { date: "2026-10-15", from: "Nebula Labs Technologies <noreply@indeed.com>", subject: "An update on your application from Nebula Labs Technologies", track: null },
  { date: "2026-10-20", from: "ISP Team from Internshala <student@mail.internshala.com>", subject: "Update: Your application has not been accepted", track: null },
  { date: "2026-10-18", from: "ISP Team from Internshala <student@mail.internshala.com>", subject: "Update: Your application has been accepted", track: null },
  { date: "2026-10-17", from: "ISP Team from Internshala <student@mail.internshala.com>", subject: "Update: Your application status is here", track: null },
  { date: "2026-10-12", from: "ISP Team from Internshala <student@mail.internshala.com>", subject: "Update: Your application has been processed", track: null },
  { date: "2026-10-19", from: "HR Labmentix <swaraj@labmentix.in>", subject: "Complete Next Steps for Labmentix Internship Selection  Within 24 Hours", track: null },
  { date: "2026-10-16", from: "Team AccioJob <placement@acciojob-team.org>", subject: "4 Roles are LIVE, walk in and interview", track: null },
  { date: "2026-10-18", from: "Google <noreply-accounts@google.com>", subject: "You shared some Google Account data with Interview Pilot", track: null },

  // ----- ads that borrow application wording: ignored -----
  { date: "2026-10-20", from: "Internshala <student@mail.internshala.com>", subject: "Update: L’Oréal India is hiring. Confirm your application today", track: null },
  { date: "2026-10-17", from: "Internshala Jobs <student@updates.internshala.com>", subject: "Update:  Kraftshala is waiting | Confirm your application", track: null },
  { date: "2026-10-17", from: "Coding Ninjas <alerts@courses.codingninjas.com>", subject: "Update: Coding Ninjas is hiring - Click here to confirm your application", track: null },
  { date: "2026-10-15", from: "Internshala <student@mail.internshala.com>", subject: "Update: Alex, Lenskart is hiring | Confirm your application", track: null },
  { date: "2026-10-13", from: "ISP Team from Internshala <student@mail.internshala.com>", subject: "Update: Your application for ISP | Confirm your spot", track: null },
  { date: "2026-10-12", from: "Internshala <student@mail.internshala.com>", subject: "Update: Your application for L’Oréal India | Complete your details", track: null },
  { date: "2026-10-05", from: "Internshala <student@mail.internshala.com>", subject: "Important: Update on your application for L'Oréal | Confirm your details", track: null },
  { date: "2026-10-03", from: "Internshala <student@mail.internshala.com>", subject: "Important: Update your application for L'Oréal | Confirm your details", track: null },
  { date: "2026-09-30", from: "Internshala <student@mail.internshala.com>", subject: "Action required: Update your application for L'Oréal", track: null },
  { date: "2026-10-17", from: "Internshala <student@internshala.com>", subject: "Cornixe is promoting Web Development internship!", track: null },
  { date: "2026-10-04", from: "Internshala <student@mail.internshala.com>", subject: "Update: Grand Internship Carnival is live | Confirm your participation status", track: null },
  { date: "2026-09-29", from: "Internshala <student@mail.internshala.com>", subject: "Update: Your Application for NMAT 2026 is Pending - Only 10 days left!", track: null },
  { date: "2026-09-29", from: "Yuva Spark Hackathon <yuvaspark@younoodle.com>", subject: "Your Application Has Been Reopened from Yuva Spark Energy Tech Hackathon 2026", track: null },
  { date: "2026-09-29", from: "Yuva Spark Hackathon <yuvaspark@younoodle.com>", subject: "Complete Your Application – Yuva Spark Energy Tech Hackathon by Schneider Electric", track: null },
  { date: "2026-10-01", from: "Yuva Spark Hackathon <support@younoodle.com>", subject: "Final 3 Days – Complete Your Application", track: null },
  { date: "2026-10-19", from: "Talent Acquisition Team <noreply@hiring.talentsjobs.in>", subject: "Hindustan Petroleum Campus Hiring Internship 2027 – Frontend Developer, Software Engineer, Data Analyst & More | Stipend Up to ₹40K", track: null },
  { date: "2026-10-19", from: "Team Unstop <noreply@unstop.news>", subject: "Hiring Alert: Unlock an Internship Opportunity with LinkedIn × Unstop & Win ₹25 Lakhs!", track: null },
  { date: "2026-10-08", from: "Team Unstop <noreply@unstop.news>", subject: "Get Your Shot at HPCL | 50 Internship Opportunities & ₹5.75L Up for Grabs", track: null },
  { date: "2026-10-13", from: "Indeed <donotreply@jobalert.indeed.com>", subject: "Internship - Digital CoE for ERP India at Airbus India Private Limited. 20 more python developer jobs in HSR Layout, Bengaluru, Karnataka", track: null },
  { date: "2026-10-02", from: "Indeed <donotreply@match.indeed.com>", subject: "Internship: AI ML Intern @ Datafoundry", track: null },
  { date: "2026-10-12", from: "Naukri E Hire Campaign <priyanka.goel@naukri.com>", subject: "✉️ Walk-in interview | First Source is hiring for Customer Support role in Mumbai in Firstsource - Mumbai", track: null },
  { date: "2026-10-14", from: "Naukri MINIs <info@minis.naukri.com>", subject: "Your application has a status they never show", track: null },
  { date: "2026-09-25", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Alex, your saved job is expiring tomorrow! ‘Software Engineer Internship (Backend) at FanCode’", track: null },

  // ----- newsletters, prep and unrelated "application": ignored -----
  { date: "2026-10-20", from: "ParakeetAI Team <noreply@parakeet-ai.com>", subject: "ParakeetAI: Rehearse with a mock interview.", track: null },
  { date: "2026-10-20", from: "Stephen from Render <hello@render.com>", subject: "Build, deploy, and monitor your application in one place", track: null },
  { date: "2026-10-18", from: "Forms Response Receipts <forms-receipts-noreply@google.com>", subject: "Thanks for filling out this form: Campus Placement - Internship Opportunities", track: null },
  { date: "2026-10-15", from: "The Educative Team <support@educative.io>", subject: "New: Grokking the Data Science Interview", track: null },
  { date: "2026-10-15", from: "LeetCode <no-reply@leetcode.com>", subject: "Alex, Join LeetCode Contest and get ready for interview prep!", track: null },
  { date: "2026-10-07", from: '"Wellfound (formerly AngelList Talent)" <team@hi.wellfound.com>', subject: "Finish your AI interview and get noticed", track: null },
  { date: "2026-10-06", from: '"Wellfound (formerly AngelList Talent)" <team@hi.wellfound.com>', subject: "Finish your interview (15 min) + get free coaching", track: null },
  { date: "2026-09-30", from: "Forbes via LinkedIn <newsletters-noreply@linkedin.com>", subject: "Job Interview Etiquette is Changing. These Rules Still Matter", track: null },
];
