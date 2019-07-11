"use strict"

const {
    dialogflow,
    Suggestions,
    BasicCard,
    Button,
    List
} = require("actions-on-google");
const request = require("request");
const functions = require("firebase-functions");
const assistantAnalytics = require("./assistant-analytics");

const CONTEXT_INPUT_CONDITION = "input_condition";
const CONTEXT_MORE_EVENTS = "more_events";

const EVENT_COUNT_FOR_VOICE = 3;
const EVENT_COUNT_FOR_SCREEN = 30;

const app = dialogflow({ debug: true });

const _hasCondition = (date, prefecture, keyword) => {
    return (!!date && !!prefecture && !!keyword);
};

const _fetchEventsAndReply = (conv, date, prefecture, keyword, start, hasTotalCount) => {
    const eventCount = conv.screen ? EVENT_COUNT_FOR_SCREEN : EVENT_COUNT_FOR_VOICE;
    return _fetchEvents(date, prefecture, keyword, start, eventCount)
        .then(result => {
            if (result.events.length === 0) {
                conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
                conv.contexts.delete(CONTEXT_MORE_EVENTS);
                delete conv.data.previousCondition;
                conv.ask(`${_createConditionPhrase(date, prefecture, keyword)}予定されていません。他の条件をどうぞ。`);
            } else {
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
                    conv.ask(msg);
                    conv.ask(new Suggestions("進む", "他の条件"));
                } else {
                    msg += conv.screen ? "気になる勉強会をタップしてください。もしくは、他の条件をお話ください。" : "他の条件をどうぞ。";
                    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
                    conv.contexts.delete(CONTEXT_MORE_EVENTS);
                    // delete conv.data.previousCondition;
                    conv.ask(msg);
                }
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
            }
            assistantAnalytics.trace(conv);
        })
        .catch(error => {
            console.log("error", error);
            conv.close("内部エラーが発生したので、会話を終わります。申し訳ございません。");
            assistantAnalytics.trace(conv);
        });
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
                console.log(body.events);
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
                        }
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

const _replyEventBasicCard = (conv, event) => {
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask("ボタンを押して詳細ページに行くか、他の条件を指定してください。");
    conv.ask(new BasicCard({
        title: event.title,
        text: `${event.place}  \n${_createStartedAtPhrase(event.startedAt)}  \n${event.catchText}`,
        buttons: new Button({
            title: "詳細ページを開く",
            url: event.eventUrl
        })
    }));
};

app.intent("input.welcome", (conv, { date, prefecture, keyword }) => {
    if (_hasCondition(date, prefecture, keyword)) {
        return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
    } else {
        conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
        conv.ask("こんにちは。各地で開催される予定の勉強会について、日付や都道府県名、キーワードによってお探しいたします。条件をどうぞ。");
        assistantAnalytics.trace(conv);
    }
});

app.intent("input.condition", (conv, { date, prefecture, keyword }) => {
    return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("implicit_invocation", (conv, { date, prefecture, keyword }) => {
    return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("select.event", (conv, params, option) => {
    const eventIndex = Number(option.substring(6));
    const previousCondition = conv.data.previousCondition;
    const event = previousCondition.result.events[eventIndex];
    _replyEventBasicCard(conv, event);
});

app.intent("more_events.continue", conv => {
    const previousCondition = conv.data.previousCondition;
    const date = previousCondition.date;
    const prefecture = previousCondition.getState;
    const keyword = previousCondition.keyword;
    const previousResult = previousCondition.result;
    const start = previousResult.resultsStart + previousResult.resultsReturned;
    return _fetchEventsAndReply(conv, date, prefecture, keyword, start, false);
});

app.intent("more_events.condition", conv => {
    const msg = "他の条件をどうぞ。";
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    delete conv.data.previousCondition;
    conv.ask(msg);
    assistantAnalytics.trace(conv);
});

app.intent("input.unknown", conv => {
    const msg = [
        "よくわかりませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "よく聞き取れませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "何と言ったのでしょうか？いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    assistantAnalytics.trace(conv);
});

app.intent("no_input.condition", conv => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    assistantAnalytics.trace(conv);
});

app.intent("no_input.more_events", conv => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    assistantAnalytics.trace(conv);
});

app.intent("more_events.unknown", conv => {
    const msg = [
        "よくわかりませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "よく聞き取れませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "何と言ったのでしょうか？続きの勉強会に進みますか？それとも他の条件で探しますか？"
    ];
    conv.contexts.delete(CONTEXT_INPUT_CONDITION);
    conv.contexts.set(CONTEXT_MORE_EVENTS, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
    assistantAnalytics.trace(conv);
});

app.intent("help", conv => {
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask("勉強会の開催情報を探すために、いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。例えば、「明日東京で開催されるJavaScript関連の勉強会を教えて」、というように言ってみてください。");
    assistantAnalytics.trace(conv);
});

app.intent("quit", conv => {
    conv.close("わかりました。また勉強会を探しに来てくださいね。");
    assistantAnalytics.trace(conv);
});

exports.connpass = functions.https.onRequest(app);
