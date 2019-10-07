"use strict"

const {
    dialogflow,
    Suggestions,
    BasicCard,
    Button,
    List,
    NewSurface
} = require("actions-on-google");
const request = require("request");
const functions = require("firebase-functions");
const { ConversationAnalytics, AssistantType } = require('conversation-analytics-client');

const CONTEXT_INPUT_CONDITION = "input_condition";
const CONTEXT_MORE_EVENTS = "more_events";
const CONTEXT_SHOW_EVENT = "show_event";

const EVENT_COUNT_FOR_VOICE = 3;
const EVENT_COUNT_FOR_SCREEN = 30;

const analytics = new ConversationAnalytics({
    assistantType: AssistantType.ACTIONS_ON_GOOGLE,
    token: process.env.ANALYTICS_TOKEN,
    userId: true
});

const app = dialogflow();

const _fetchEventsAndReply = async (conv, date, prefecture, keyword, start, hasTotalCount) => {
    const eventCount = conv.screen ? EVENT_COUNT_FOR_SCREEN : EVENT_COUNT_FOR_VOICE;
    try {
        const result = await _fetchEvents(date, prefecture, keyword, start, eventCount)
        if (result.events.length === 0) {
            conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
            conv.contexts.delete(CONTEXT_MORE_EVENTS);
            delete conv.data.previousCondition;
            conv.ask(`${_createConditionPhrase(date, prefecture, keyword)}予定されていません。他の条件をどうぞ。`);
        } else {
            const suggestions = [];
            let msg = hasTotalCount ? `${_createConditionPhrase(date, prefecture, keyword)}${result.resultsAvailable}件予定されています。` : "";
            if (!conv.screen) {
                if (result.events.length === 1) {
                    msg += _createEventInformationPhrase(result.events[0]);
                } else {
                    result.events.forEach((event, index) => {
                        msg += _createEventInformationPhraseWithIndex(start + index, event);
                    });
                }
            }
            conv.data.previousCondition = {
                date: date,
                getState: prefecture,
                keyword: keyword,
                result: result
            };
            if (!conv.screen && _isExistsMoreEvents(result)) {
                msg += `${start + eventCount}件目以降に進みますか？それとも他の条件で検索しますか？`;
                conv.contexts.delete(CONTEXT_INPUT_CONDITION);
                conv.contexts.set(CONTEXT_MORE_EVENTS, 1);
                suggestions.push("進む", "他の条件");
            } else {
                msg += conv.screen ? "気になる勉強会をタップしてください。もしくは、他の条件をお話ください。" : "他の条件をどうぞ。";
                conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
                conv.contexts.delete(CONTEXT_MORE_EVENTS);
                // delete conv.data.previousCondition;
            }
            if (!conv.surface.capabilities.has("actions.capability.WEB_BROWSER")
                    && conv.available.surfaces.capabilities.has("actions.capability.WEB_BROWSER")) {
                msg += "また、この検索結果をスマートフォンに送ることもできます。";
                suggestions.push("スマートフォンに送る");
            }
            conv.ask(msg);
            if (conv.screen) {
                if (result.events.length === 1) {
                    _replyEventBasicCard(conv, result.events[0]);
                } else {
                    const items = {};
                    result.events.forEach((event, index) => {
                        items[`EVENT_${index}`] = {
                            title: event.title,
                            description: `${result.events[0].place}\n${_createStartedAtPhrase(event.startedAt)}`
                        };
                    });
                    conv.ask(new List({
                        items
                    }));
                }
            }
            if (suggestions.length > 0) {
                conv.ask(new Suggestions(...suggestions));
            }
        }
        await analytics.trace(conv);
        console.log('conv', JSON.stringify(conv));
    } catch(error) {
        console.log("error", error);
        conv.close("内部エラーが発生したので、会話を終わります。申し訳ございません。");
        await analytics.trace(conv);
        console.log('conv', JSON.stringify(conv));
    }
};

const _replyEventBasicCard = (conv, event) => {
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.set(CONTEXT_SHOW_EVENT, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    if (conv.surface.capabilities.has('actions.capability.WEB_BROWSER')) {
        conv.ask("ボタンを押して詳細ページに行くか、他の条件を指定してください。");
    } else {
        conv.ask("他の条件を指定してください。");
    }
    conv.ask(new BasicCard({
        title: event.title,
        subtitle: event.series.title,
        text: `場所: ${event.place}  \n日付:${_createStartedAtPhrase(event.startedAt)}  \n現在/定員: ${Number(event.accepted) + Number(event.waiting)} / ${event.limit}  \n${event.catchText}`,
        buttons: new Button({
            title: "詳細ページを開く",
            url: event.eventUrl
        })
    }));
};

const _fetchEvents = (date, prefecture, keyword, start, count) => {
    console.log("date,prefecture,keyword,start,count", date, prefecture, keyword, start, count);
    return new Promise((resolve, reject) => {
        let url = `https://connpass.com/api/v1/event/?start=${start}&count=${count}&order=1`;
        if (date) {
            url += `&ymd=${date.substring(0, 10).replace(/-/g, "")}`;
        }
        const keywords = [];
        if (keyword) {
            keywords.push(keyword);
        }
        if (prefecture) {
            keywords.push(prefecture);
        }
        if (keywords.length !== 0) {
            url += "&keyword=" + keywords.map(x => { return encodeURIComponent(x); }).join(",");
        }
        const headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": "request_on_nodejs"
        };
        const options = {
            url: url,
            method: "GET",
            headers: headers,
            json: true
        };
        request(options, (error, response, body) => {
            if (error) {
                console.log("error-1");
                reject(error);
            } else if (response.statusCode !== 200) {
                console.log("error-2");
                console.log("statusCode", response.statusCode);
                reject(response.statusCode);
            } else {
                const events = body.events.map(event => {
                    return {
                        place: event.place,
                        title: event.title,
                        startedAt: event.started_at,
                        eventUrl: event.event_url,
                        catchText: event.catch,
                        series: {
                            url: event.series ? event.series.url : "",
                            title: event.series ? event.series.title : ""
                        },
                        limit: event.limit,
                        accepted: event.accepted,
                        waiting: event.waiting
                    };
                });
                resolve({
                    resultsStart: body.results_start,
                    resultsReturned: body.results_returned,
                    resultsAvailable: body.results_available,
                    events: events
                });
            }
        });
    });
};

const _isExistsMoreEvents = result => {
    console.log('result', JSON.stringify(result, null, 2));
    return result.resultsStart + result.resultsReturned <= result.resultsAvailable;
};

const _createStartedAtPhrase = datetime => {
    // datetime = '2018-02-03T09:40:00+09:00'
    const month = Number(datetime.substring(5, 7));
    const day = Number(datetime.substring(8, 10));
    const hour = Number(datetime.substring(11, 13));
    const minute = Number(datetime.substring(14, 16));
    if (minute === 0) {
        return `${month}月${day}日 ${hour}時`;
    } else {
        return `${month}月${day}日 ${hour}時${minute}分`;
    }
};

const _createEventInformationPhraseWithIndex = (index, event) => {
    return `${index}番目の勉強会は、${_createEventInformationPhrase(event)}`;
};

const _createEventInformationPhrase = (event) => {
    const place = event.place;
    const title = event.title;
    const startedAt = _createStartedAtPhrase(event.startedAt);
    let msg = "";
    if (place) {
        msg += `${place}にて、`;
    }
    return `${msg}${title}が、${startedAt}から行われます。`;
};

const _createConditionPhrase = (date, prefecture, keyword) => {
    const result = [];
    if (date) {
        const d = new Date(date);
        result.push(`日付が${d.getMonth() + 1}月${d.getDate()}日`)
    }
    if (prefecture) {
        result.push(`場所が${prefecture}`);
    }
    if (keyword) {
        result.push(`キーワードが${keyword}`);
    }
    return `${result.join("、")}の条件にマッチする勉強会は、`;
};

const _hasCondition = (date, prefecture, keyword) => {
    return (!!date && !!prefecture);
};

app.intent("input.welcome", async (conv, { date, prefecture, keyword }) => {
    if (_hasCondition(date, prefecture, keyword)) {
        return await _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
    } else {
        conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
        conv.ask("各地で開催される勉強会をお探しいたします。都道府県名や日付を教えてください。または「土曜日に東京でJavaScript」のように話してみてください。");
        await analytics.trace(conv);
        console.log('conv', JSON.stringify(conv));
    }
});

app.intent("input.condition", async (conv, { date, prefecture, keyword }) => {
    return await _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("implicit_invocation", async (conv, { date, prefecture, keyword }) => {
    return await _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("select.event", async (conv, params, option) => {
    const eventIndex = Number(option.substring(6));
    const previousCondition = conv.data.previousCondition;
    const event = previousCondition.result.events[eventIndex];
    _replyEventBasicCard(conv, event);
    conv.ask(new Suggestions("一覧に戻る"));
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("send.to.smartphone", async (conv) => {
    const context = "わかりました。検索結果をスマートフォンに通知します";
    const notification = "検索結果をご確認ください。";
    const capabilities = ["actions.capability.SCREEN_OUTPUT", "actions.capability.WEB_BROWSER"];
    conv.ask(new NewSurface({context, notification, capabilities}));
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("receive.on.smartphone", async (conv, input, newSurface) => {
    conv.contexts.delete(CONTEXT_SHOW_EVENT);
    const previousCondition = conv.data.previousCondition;
    if (previousCondition) {
        const date = previousCondition.date;
        const prefecture = previousCondition.getState;
        const keyword = previousCondition.keyword;
        const previousResult = previousCondition.result;
        const start = previousResult.resultsStart;
        return await _fetchEventsAndReply(conv, date, prefecture, keyword, start, true);
    } else {
        const msg = "他の条件をどうぞ。";
        conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
        conv.contexts.delete(CONTEXT_MORE_EVENTS);
        delete conv.data.previousCondition;
        conv.ask(msg);
        await analytics.trace(conv);
        console.log('conv', JSON.stringify(conv));
    }
});

app.intent("more_events.continue", async (conv) => {
    const previousCondition = conv.data.previousCondition;
    const date = previousCondition.date;
    const prefecture = previousCondition.getState;
    const keyword = previousCondition.keyword;
    const previousResult = previousCondition.result;
    const start = previousResult.resultsStart + previousResult.resultsReturned;
    return await _fetchEventsAndReply(conv, date, prefecture, keyword, start, false);
});

app.intent("more_events.condition", async (conv) => {
    const msg = "他の条件をどうぞ。";
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    delete conv.data.previousCondition;
    conv.ask(msg);
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("back.to.result", async (conv) => {
    conv.contexts.delete(CONTEXT_SHOW_EVENT);
    const previousCondition = conv.data.previousCondition;
    if (previousCondition) {
        const date = previousCondition.date;
        const prefecture = previousCondition.getState;
        const keyword = previousCondition.keyword;
        const previousResult = previousCondition.result;
        const start = previousResult.resultsStart;
        return await _fetchEventsAndReply(conv, date, prefecture, keyword, start, false);
    } else {
        const msg = "他の条件をどうぞ。";
        conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
        conv.contexts.delete(CONTEXT_MORE_EVENTS);
        delete conv.data.previousCondition;
        conv.ask(msg);
        await analytics.trace(conv);
        console.log('conv', JSON.stringify(conv));
    }
});

app.intent("input.unknown", async (conv) => {
    const msg = [
        "よくわかりませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "よく聞き取れませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "何と言ったのでしょうか？いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("no_input.condition", async (conv) => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("no_input.more_events", async (conv) => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("more_events.unknown", async (conv) => {
    const msg = [
        "よくわかりませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "よく聞き取れませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "何と言ったのでしょうか？続きの勉強会に進みますか？それとも他の条件で探しますか？"
    ];
    conv.contexts.delete(CONTEXT_INPUT_CONDITION);
    conv.contexts.set(CONTEXT_MORE_EVENTS, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("help", async (conv) => {
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask("勉強会の開催情報を探すために、いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。例えば、「明日東京で開催されるJavaScript関連の勉強会を教えて」、というように言ってみてください。");
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

app.intent("quit", async (conv) => {
    conv.close("わかりました。また勉強会を探しに来てくださいね。");
    await analytics.trace(conv);
    console.log('conv', JSON.stringify(conv));
});

exports.connpass = functions.https.onRequest(app);
