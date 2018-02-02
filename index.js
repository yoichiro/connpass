"use strict"

process.env.DEBUG = "actions-on-google:*";

const App = require("actions-on-google").DialogflowApp;
const request = require("request");

const ACTION_INPUT_WELCOME = "input.welcome";
const ACTION_INPUT_CONDITION = "input.condition";
const ACTION_INPUT_MORE_EVENTS = "input.more_events";
const ACTION_INPUT_UNKNOWN = "input.unknown";
const ACTION_HELP = "help";
const ACTION_QUIT = "quit";

const CONTEXT_INPUT_CONDITION = "input_condition";
const CONTEXT_MORE_EVENTS = "more_events";

exports.connpass = (req, res) => {
    const app = new App({request: req, response: res});

    console.log(`connpassAction Request headers: ${JSON.stringify(req.headers)}`);
    console.log(`connpassAction Request body: ${JSON.stringify(req.body)}`);

    const inputWelcome = app => {
        const date = app.getArgument("date");
        const prefecture = app.getArgument("prefecture");
        const keyword = app.getArgument("keyword");
        if (_hasCondition(date, prefecture, keyword)) {
            _fetchEventsAndReply(date, prefecture, keyword, 1, true);
        } else {
            app.setContext(CONTEXT_INPUT_CONDITION);
            app.ask(
                "こんにちは。各地で開催される予定の勉強会について、日付や都道府県名、キーワードによってお探しいたします。条件をどうぞ。",
                _noInputCondition()
            );
        }
    };

    const _noInputCondition = () => {
        return [
            "よく聞き取れませんでした。条件を言ってください。",
            "まだそこにいらっしゃいますか？条件をどうぞ。",
            "ここで終わりにしましょう。また勉強会を探しに来てくださいね。"
        ];
    };

    const _hasCondition = (date, prefecture, keyword) => {
        return (!!date && !!prefecture && !!keyword);
    };

    const _fetchEvents = (date, prefecture, keyword, start) => {
        console.log("date,prefecture,keyword,start", date, prefecture, keyword, start);
        return new Promise((resolve, reject) => {
            let url = `https://connpass.com/api/v1/event/?start=${start}&count=3&order=1`;
            if (date) {
                url += `&ymd=${date.replace(/-/g, "")}`;
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
            console.log("url", url);
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
                    reject(response.statuscode);
                } else {
                    const events = body.events.map(event => {
                        return {
                            place: event.place,
                            title: event.title,
                            startedAt: event.started_at
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
        return (result.resultsStart - 1) + result.resultsReturned < result.resultsAvailable;
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

    const _fetchEventsAndReply = (date, prefecture, keyword, start, hasTotalCount) => {
        console.log("start", start);
        _fetchEvents(date, prefecture, keyword, start)
            .then(result => {
                if (result.events.length === 0) {
                    app.setContext(CONTEXT_INPUT_CONDITION);
                    app.setContext(CONTEXT_MORE_EVENTS, 0);
                    delete app.data.previousCondition;
                    app.ask(
                        `${_createConditionPhrase(date, prefecture, keyword)}予定されていません。他の条件をどうぞ。`,
                        _noInputCondition()
                    );
                } else {
                    let msg = hasTotalCount ? `${_createConditionPhrase(date, prefecture, keyword)}${result.resultsAvailable}件予定されています。` : "";
                    if (result.events.length === 1) {
                        msg += _createEventInformationPhrase(result.events[0]);
                    } else {
                        result.events.forEach((event, index) => {
                            msg += _createEventInformationPhraseWithIndex(start + index, event);
                        });
                    }
                    if (_isExistsMoreEvents(result)) {
                        app.data.previousCondition = {
                            date: date,
                            getState: prefecture,
                            keyword: keyword,
                            result: result
                        };
                        msg += "続けますか？";
                        app.setContext(CONTEXT_INPUT_CONDITION, 0);
                        app.setContext(CONTEXT_MORE_EVENTS);
                        app.askForConfirmation(msg);
                    } else {
                        msg += "他の条件をどうぞ。";
                        app.setContext(CONTEXT_INPUT_CONDITION);
                        app.setContext(CONTEXT_MORE_EVENTS, 0);
                        delete app.data.previousCondition;
                        app.ask(msg, _noInputCondition());
                    }
                }
            })
            .catch(error => {
                console.log("error", error);
                app.tell("内部エラーが発生したので、会話を終わります。申し訳ございません。");
            });
    };

    const inputCondition = app => {
        const date = app.getArgument("date");
        const prefecture = app.getArgument("prefecture");
        const keyword = app.getArgument("keyword");
        _fetchEventsAndReply(date, prefecture, keyword, 1, true);
    };

    const inputMoreEvents = app => {
        if (app.getUserConfirmation()) {
            const previousCondition = app.data.previousCondition;
            const date = previousCondition.date;
            const prefecture = previousCondition.getState;
            const keyword = previousCondition.keyword;
            const previousResult = previousCondition.result;
            const start = previousResult.resultsStart + previousResult.resultsReturned;
            _fetchEventsAndReply(date, prefecture, keyword, start, false);
        } else {
            const msg = "他の条件をどうぞ。";
            app.setContext(CONTEXT_INPUT_CONDITION);
            app.setContext(CONTEXT_MORE_EVENTS, 0);
            delete app.data.previousCondition;
            app.ask(msg, _noInputCondition());
        }
    };

    const inputUnknown = app => {
        const msg = [
            "よくわかりませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
            "よく聞き取れませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
            "何と言ったのでしょうか？いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。"
        ];
        app.ask(msg[Math.floor(Math.random() * msg.length)], _noInputCondition());
    };

    const help = app => {
        app.ask(
            "勉強会の開催情報を探すために、いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。例えば、「明日東京で開催されるJavaScript関連の勉強会を教えて」、というように言ってみてください。",
            _noInputCondition()
        );
        app.setContext(CONTEXT_INPUT_CONDITION);
    };

    const quit = app => {
        app.tell("わかりました。また勉強会を探しに来てくださいね。");
    };

    const actionMap = new Map();
    actionMap.set(ACTION_INPUT_WELCOME, inputWelcome);
    actionMap.set(ACTION_INPUT_CONDITION, inputCondition);
    actionMap.set(ACTION_INPUT_MORE_EVENTS, inputMoreEvents);
    actionMap.set(ACTION_INPUT_UNKNOWN, inputUnknown);
    actionMap.set(ACTION_HELP, help);
    actionMap.set(ACTION_QUIT, quit);

    app.handleRequest(actionMap);
};
