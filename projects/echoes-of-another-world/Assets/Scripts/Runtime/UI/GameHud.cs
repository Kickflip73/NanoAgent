using EchoesOfAnotherWorld.Runtime.Echoes;
using EchoesOfAnotherWorld.Runtime.Events;
using UnityEngine;
using UnityEngine.UI;

namespace EchoesOfAnotherWorld.Runtime.UI
{
    public sealed class GameHud : MonoBehaviour
    {
        private readonly Text[] echoSlots = new Text[EchoContainer.MaximumSlots];
        private FloatEventChannel healthChanged;
        private IntEventChannel wantedChanged;
        private StringEventChannel statusChanged;
        private StringEventChannel dialogueChanged;
        private EchoContainer echoContainer;
        private Slider healthSlider;
        private Text wantedText;
        private Text statusText;
        private Text dialogueText;

        public void Configure(
            FloatEventChannel healthChannel,
            IntEventChannel wantedChannel,
            StringEventChannel statusChannel,
            StringEventChannel dialogueChannel,
            EchoContainer container,
            float initialHealth)
        {
            healthChanged = healthChannel;
            wantedChanged = wantedChannel;
            statusChanged = statusChannel;
            dialogueChanged = dialogueChannel;
            echoContainer = container;
            BuildCanvas();

            healthChanged.Raised += OnHealthChanged;
            wantedChanged.Raised += OnWantedChanged;
            statusChanged.Raised += OnStatusChanged;
            dialogueChanged.Raised += OnDialogueChanged;
            echoContainer.EquipmentChanged += RefreshEchoSlots;

            OnHealthChanged(initialHealth);
            OnWantedChanged(0);
            RefreshEchoSlots();
        }

        private void OnDestroy()
        {
            if (healthChanged != null)
            {
                healthChanged.Raised -= OnHealthChanged;
            }

            if (wantedChanged != null)
            {
                wantedChanged.Raised -= OnWantedChanged;
            }

            if (statusChanged != null)
            {
                statusChanged.Raised -= OnStatusChanged;
            }

            if (dialogueChanged != null)
            {
                dialogueChanged.Raised -= OnDialogueChanged;
            }

            if (echoContainer != null)
            {
                echoContainer.EquipmentChanged -= RefreshEchoSlots;
            }
        }

        private void BuildCanvas()
        {
            Canvas canvas = gameObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            gameObject.AddComponent<CanvasScaler>().uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            gameObject.AddComponent<GraphicRaycaster>();

            Font font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            healthSlider = CreateHealthBar(canvas.transform);
            wantedText = CreateText(canvas.transform, font, "通缉", 24, TextAnchor.UpperRight);
            SetRect(wantedText.rectTransform, new Vector2(1f, 1f), new Vector2(1f, 1f), new Vector2(-220f, -65f), new Vector2(200f, 40f));

            for (int index = 0; index < echoSlots.Length; index++)
            {
                GameObject panel = CreatePanel(canvas.transform, "残响槽", new Color(0.06f, 0.07f, 0.1f, 0.85f));
                SetRect(panel.GetComponent<RectTransform>(), new Vector2(0.5f, 0f), new Vector2(0.5f, 0f), new Vector2((index - 1.5f) * 115f, 48f), new Vector2(105f, 46f));
                Text slot = CreateText(panel.transform, font, $"[{index + 1}]", 14, TextAnchor.MiddleCenter);
                Stretch(slot.rectTransform);
                echoSlots[index] = slot;
            }

            statusText = CreateText(canvas.transform, font, "", 16, TextAnchor.LowerLeft);
            SetRect(statusText.rectTransform, Vector2.zero, Vector2.zero, new Vector2(20f, 110f), new Vector2(420f, 70f));

            GameObject dialoguePanel = CreatePanel(canvas.transform, "对话框", new Color(0.03f, 0.025f, 0.05f, 0.82f));
            SetRect(dialoguePanel.GetComponent<RectTransform>(), new Vector2(0.5f, 0f), new Vector2(0.5f, 0f), new Vector2(0f, 125f), new Vector2(650f, 100f));
            dialogueText = CreateText(dialoguePanel.transform, font, "", 18, TextAnchor.MiddleLeft);
            Stretch(dialogueText.rectTransform);
            dialoguePanel.SetActive(false);

            Text controls = CreateText(canvas.transform, font, "WASD 移动  J/鼠标 攻击  Space 闪避  E 残响  Q 切换  F 对话", 14, TextAnchor.UpperLeft);
            SetRect(controls.rectTransform, new Vector2(0f, 1f), new Vector2(0f, 1f), new Vector2(20f, -75f), new Vector2(540f, 30f));
        }

        private static Slider CreateHealthBar(Transform parent)
        {
            GameObject sliderObject = new GameObject("玩家血条", typeof(RectTransform), typeof(Slider));
            sliderObject.transform.SetParent(parent, false);
            Slider slider = sliderObject.GetComponent<Slider>();
            SetRect(slider.GetComponent<RectTransform>(), new Vector2(0f, 1f), new Vector2(0f, 1f), new Vector2(20f, -28f), new Vector2(260f, 24f));

            GameObject backgroundObject = new GameObject("Background", typeof(RectTransform), typeof(Image));
            backgroundObject.transform.SetParent(sliderObject.transform, false);
            Image background = backgroundObject.GetComponent<Image>();
            background.color = new Color(0.12f, 0.05f, 0.06f, 0.9f);
            Stretch(background.rectTransform);

            GameObject fillArea = new GameObject("Fill Area", typeof(RectTransform));
            fillArea.transform.SetParent(sliderObject.transform, false);
            Stretch(fillArea.GetComponent<RectTransform>());
            GameObject fillObject = new GameObject("Fill", typeof(RectTransform), typeof(Image));
            fillObject.transform.SetParent(fillArea.transform, false);
            Image fill = fillObject.GetComponent<Image>();
            fill.color = new Color(0.75f, 0.12f, 0.16f, 1f);
            Stretch(fill.rectTransform);
            slider.fillRect = fill.rectTransform;
            slider.minValue = 0f;
            slider.maxValue = 1f;
            slider.interactable = false;
            return slider;
        }

        private static Text CreateText(Transform parent, Font font, string value, int size, TextAnchor alignment)
        {
            GameObject textObject = new GameObject("Text", typeof(RectTransform), typeof(Text));
            textObject.transform.SetParent(parent, false);
            Text text = textObject.GetComponent<Text>();
            text.font = font;
            text.text = value;
            text.fontSize = size;
            text.alignment = alignment;
            text.color = Color.white;
            return text;
        }

        private static GameObject CreatePanel(Transform parent, string panelName, Color color)
        {
            GameObject panel = new GameObject(panelName, typeof(RectTransform), typeof(Image));
            panel.transform.SetParent(parent, false);
            panel.GetComponent<Image>().color = color;
            return panel;
        }

        private static void SetRect(RectTransform rect, Vector2 anchorMin, Vector2 anchorMax, Vector2 position, Vector2 size)
        {
            rect.anchorMin = anchorMin;
            rect.anchorMax = anchorMax;
            rect.pivot = anchorMin;
            rect.anchoredPosition = position;
            rect.sizeDelta = size;
        }

        private static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        private void OnHealthChanged(float normalizedHealth)
        {
            healthSlider.value = Mathf.Clamp01(normalizedHealth);
        }

        private void OnWantedChanged(int level)
        {
            wantedText.text = $"通缉：{new string('★', Mathf.Clamp(level, 0, 3))}{new string('☆', 3 - Mathf.Clamp(level, 0, 3))}";
        }

        private void OnStatusChanged(string message)
        {
            statusText.text = message;
        }

        private void OnDialogueChanged(string message)
        {
            dialogueText.text = message;
            dialogueText.transform.parent.gameObject.SetActive(!string.IsNullOrEmpty(message));
        }

        private void RefreshEchoSlots()
        {
            for (int index = 0; index < echoSlots.Length; index++)
            {
                EchoMark mark = echoContainer.GetEquipped(index);
                string selection = index == echoContainer.SelectedSlot ? ">" : " ";
                echoSlots[index].text = $"{selection}槽 {index + 1}\n{(mark == null ? "空" : mark.DisplayName)}";
            }
        }
    }
}
